/**
 * Triage orchestrator. For each direct dependency with an advisory, gathers
 * severity (CVSS), exploit likelihood (EPSS), and reachability, then routes to
 * FIX / SKIP / ESCALATE with an evidence-backed rationale.
 *
 * The agent (later phase) only ever runs on FIX findings. SKIP and ESCALATE are
 * decided deterministically, before any model is invoked.
 */
import type { Finding } from "./types.ts";
import { readDirectDependencies } from "./lockfile.ts";
import { fetchAdvisory } from "./osv.ts";
import { fetchEpss } from "./epss.ts";
import { buildReachability } from "./reachability.ts";
import { matchSensitive } from "./policy.ts";

/** Composite risk 0-100: 60% severity (CVSS), 40% exploit likelihood (EPSS). */
function compositeRisk(cvss: number | null, epss: number | null): number {
  const sev = ((cvss ?? 0) / 10) * 100;
  if (epss === null) return Math.round(sev);
  return Math.round(0.6 * sev + 0.4 * epss * 100);
}

export interface TriageReport {
  target: string;
  entry: string | null;
  scannedFiles: number;
  scannedDeps: number;
  findings: Finding[];
}

export async function triage(targetRepo: string, refresh = false): Promise<TriageReport> {
  const deps = readDirectDependencies(targetRepo);
  const reach = buildReachability(targetRepo);
  const findings: Finding[] = [];

  for (const dep of deps) {
    const advisory = await fetchAdvisory(dep, refresh);
    if (!advisory) continue; // clean dependency

    const epss = advisory.cve ? await fetchEpss(advisory.cve, refresh) : null;
    const reachability = reach.forPackage(dep.name);
    const riskScore = compositeRisk(advisory.cvssScore, epss?.epss ?? null);

    let route: Finding["route"];
    let rationale: string;
    let sensitiveMatch: string | null = null;

    if (!reachability.reachable) {
      route = "SKIP";
      rationale = `Vulnerable package present but not reachable from ${reach.entry ?? "any entrypoint"} (0 reachable import sites across ${reachability.scannedFiles} files). Patching would add change-risk without reducing exposure.`;
    } else {
      const sensitive = matchSensitive(reachability.importSites);
      if (sensitive) {
        route = "ESCALATE";
        sensitiveMatch = sensitive.name;
        rationale = `Reachable AND on a sensitive path — ${sensitive.description}. Requires human sign-off; agents do not auto-modify money-movement code.`;
      } else if (!advisory.fixedVersion) {
        route = "ESCALATE";
        rationale = "Reachable on a live call path, but no clean upstream fix is recorded. A human must choose the mitigation before an agent changes code.";
      } else {
        route = "FIX";
        rationale = `Reachable on a live call path with a clean upstream fix (${dep.name}@${advisory.fixedVersion}). Safe for an agent to reproduce, patch, and open a PR.`;
      }
    }

    findings.push({
      dependency: dep,
      advisory,
      epss: epss?.epss ?? null,
      epssPercentile: epss?.percentile ?? null,
      riskScore,
      reachability,
      route,
      rationale,
      sensitiveMatch,
    });
  }

  findings.sort((a, b) => b.riskScore - a.riskScore);
  return {
    target: targetRepo,
    entry: reach.entry,
    scannedFiles: reach.scannedFiles,
    scannedDeps: deps.length,
    findings,
  };
}
