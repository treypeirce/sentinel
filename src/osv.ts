/**
 * OSV.dev client. Queries the public vulnerability database for a given
 * (package, version) and normalizes the result into a single aggregated
 * Advisory. All responses are cached to disk so the demo runs offline.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { Advisory, Dependency } from "./types.ts";
import { scoreFromVector, scoreFromQualitative, severityFromScore } from "./cvss.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "osv");

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type?: string; events?: { introduced?: string; fixed?: string }[] }[];
    severity?: { type: string; score: string }[];
    database_specific?: { severity?: string };
  }[];
  database_specific?: { severity?: string };
}

function cacheKey(dep: Dependency): string {
  return `${dep.name.replace(/[/@]/g, "_")}@${dep.version}.json`;
}

async function fetchVulns(dep: Dependency, refresh: boolean): Promise<OsvVuln[]> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, cacheKey(dep));
  if (!refresh && existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as OsvVuln[];
  }
  const res = await fetch("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: dep.version, package: { name: dep.name, ecosystem: "npm" } }),
  });
  if (!res.ok) throw new Error(`OSV ${res.status} for ${dep.name}@${dep.version}`);
  const body = (await res.json()) as { vulns?: OsvVuln[] };
  const vulns = body.vulns ?? [];
  writeFileSync(path, JSON.stringify(vulns, null, 2));
  return vulns;
}

function cmpSemver(a: string, b: string): number {
  const pa = a.replace(/^[^\d]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^[^\d]*/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function vectorFrom(sev?: { type: string; score: string }[]): string | null {
  const hit = sev?.find((s) => typeof s.score === "string" && s.score.startsWith("CVSS:"));
  return hit?.score ?? null;
}

function fixedFor(vuln: OsvVuln, name: string): string | null {
  const fixes: string[] = [];
  for (const aff of vuln.affected ?? []) {
    if (aff.package?.name && aff.package.name !== name) continue;
    for (const r of aff.ranges ?? []) {
      for (const ev of r.events ?? []) {
        if (ev.fixed) fixes.push(ev.fixed);
      }
    }
  }
  if (fixes.length === 0) return null;
  return fixes.sort(cmpSemver)[0]; // smallest version that fixes it
}

/** Query OSV and aggregate into one Advisory (worst score, highest clean fix). */
export async function fetchAdvisory(dep: Dependency, refresh = false): Promise<Advisory | null> {
  const vulns = await fetchVulns(dep, refresh);
  if (vulns.length === 0) return null;

  let best: Advisory | null = null;
  let maxFixed: string | null = null;

  for (const v of vulns) {
    const vector = vectorFrom(v.severity) ?? vectorFrom(v.affected?.[0]?.severity);
    const qualitative = v.database_specific?.severity ?? v.affected?.[0]?.database_specific?.severity;
    const score = vector ? scoreFromVector(vector) : qualitative ? scoreFromQualitative(qualitative) : null;
    const cve = (v.aliases ?? []).find((a) => a.startsWith("CVE-")) ?? null;
    const fixed = fixedFor(v, dep.name);
    if (fixed && (!maxFixed || cmpSemver(fixed, maxFixed) > 0)) maxFixed = fixed;

    const advisory: Advisory = {
      id: v.id,
      cve,
      summary: (v.summary ?? v.details ?? "").split("\n")[0].slice(0, 160),
      cvssVector: vector,
      cvssScore: score,
      severity: score !== null ? severityFromScore(score) : (qualitative ?? "UNKNOWN").toUpperCase(),
      fixedVersion: fixed,
      advisoryCount: vulns.length,
    };
    if (!best || (advisory.cvssScore ?? 0) > (best.cvssScore ?? 0)) best = advisory;
  }

  if (best) best.fixedVersion = maxFixed;
  return best;
}
