/**
 * EPSS enrichment. EPSS (Exploit Prediction Scoring System, FIRST.org) is the
 * probability a CVE will be exploited in the wild in the next 30 days. Combined
 * with CVSS (severity) it separates "theoretically bad" from "actively risky".
 * Cached to disk; degrades gracefully when unavailable.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache", "epss");

export interface EpssResult {
  epss: number; // 0-1
  percentile: number; // 0-1
}

export async function fetchEpss(cve: string, refresh = false): Promise<EpssResult | null> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `${cve}.json`);
  if (!refresh && existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")) as EpssResult | null;
  }
  try {
    const res = await fetch(`https://api.first.org/data/v1/epss?cve=${encodeURIComponent(cve)}`);
    if (!res.ok) throw new Error(`EPSS ${res.status}`);
    const body = (await res.json()) as { data?: { epss?: string; percentile?: string }[] };
    const row = body.data?.[0];
    const result: EpssResult | null = row?.epss
      ? { epss: parseFloat(row.epss), percentile: parseFloat(row.percentile ?? "0") }
      : null;
    writeFileSync(path, JSON.stringify(result));
    return result;
  } catch {
    return null; // EPSS is enrichment, never a hard dependency
  }
}
