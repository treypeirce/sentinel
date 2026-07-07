/**
 * Fleet triage — scan several services and produce a portfolio view. The same
 * CVE lands differently across services (reachable → FIX, dead dep → SKIP,
 * money-path → ESCALATE), which is exactly what makes triage worth doing at
 * scale instead of firehosing PRs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { triage, type TriageReport } from "./triage.ts";
import type { Route } from "./types.ts";

export interface FleetServiceResult {
  name: string;
  repoUrl: string;
  report: TriageReport;
}

export interface FleetReport {
  services: FleetServiceResult[];
  summary: { services: number; findings: number; FIX: number; SKIP: number; ESCALATE: number };
}

export async function triageFleet(configPath: string, rootDir: string, refresh = false): Promise<FleetReport> {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
    services: { name: string; path: string; repoUrl: string }[];
  };

  const services: FleetServiceResult[] = [];
  const summary = { services: 0, findings: 0, FIX: 0, SKIP: 0, ESCALATE: 0 };

  for (const s of cfg.services) {
    const abs = resolve(rootDir, s.path);
    const report = await triage(abs, refresh);
    services.push({ name: s.name, repoUrl: s.repoUrl, report });
    summary.services += 1;
    for (const f of report.findings) {
      summary.findings += 1;
      summary[f.route as Route] += 1;
    }
  }

  return { services, summary };
}
