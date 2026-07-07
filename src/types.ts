/** Shared types for the Sentinel triage engine. */

export type Route = "FIX" | "SKIP" | "ESCALATE";

export interface Dependency {
  name: string;
  version: string;
  direct: boolean;
}

export interface Advisory {
  id: string; // OSV / GHSA id
  cve: string | null; // primary CVE alias, if any
  summary: string;
  cvssVector: string | null;
  cvssScore: number | null; // 0-10 base score
  severity: string; // CRITICAL | HIGH | MEDIUM | LOW | UNKNOWN
  fixedVersion: string | null;
  advisoryCount: number; // total advisories affecting this dependency
}

export interface ReachabilityEvidence {
  reachable: boolean;
  importSites: string[]; // src-relative files that import the package
  reachablePath: string[] | null; // entrypoint -> ... -> import site
  scannedFiles: number;
}

export interface Finding {
  dependency: Dependency;
  advisory: Advisory;
  epss: number | null; // 0-1 probability of exploitation in next 30 days
  epssPercentile: number | null;
  riskScore: number; // composite 0-100
  reachability: ReachabilityEvidence;
  route: Route;
  rationale: string;
  sensitiveMatch: string | null; // policy rule name, when ESCALATED
}
