/** ANSI report renderer for the triage queue. Legible on a projector. */
import type { Finding } from "./types.ts";
import type { TriageReport } from "./triage.ts";
import type { FleetReport } from "./fleet.ts";

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[97m",
  bgline: "\x1b[38;5;245m",
};

const routeStyle: Record<Finding["route"], string> = {
  FIX: c.cyan,
  SKIP: c.dim,
  ESCALATE: c.yellow,
};
const routeGlyph: Record<Finding["route"], string> = {
  FIX: "→ FIX",
  SKIP: "· SKIP",
  ESCALATE: "! ESCALATE",
};

function pad(s: string, n: number): string {
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (clean.length > n) return clean.slice(0, n - 1) + "…" + " ".repeat(0);
  return s + " ".repeat(n - clean.length);
}

function pct(x: number | null): string {
  if (x === null) return "n/a";
  return `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;
}

export function render(report: TriageReport): string {
  const L: string[] = [];
  L.push("");
  L.push(`${c.bold}${c.white}  SENTINEL${c.reset} ${c.dim}· governed vulnerability triage${c.reset}`);
  L.push(
    `  ${c.dim}target${c.reset} ${report.target.split("/").pop()}   ${c.dim}entry${c.reset} ${report.entry ?? "?"}   ${c.dim}scanned${c.reset} ${report.scannedDeps} deps · ${report.scannedFiles} files`,
  );
  L.push("");

  // header
  L.push(
    `  ${c.dim}${pad("PACKAGE", 20)}${pad("ADVISORY", 20)}${pad("CVSS", 12)}${pad("EPSS", 9)}${pad("REACH", 8)}ROUTE${c.reset}`,
  );
  L.push(`  ${c.bgline}${"─".repeat(78)}${c.reset}`);

  for (const f of report.findings) {
    const pkg = `${f.dependency.name}@${f.dependency.version}`;
    const adv = f.advisory.cve ?? f.advisory.id;
    const cvss =
      f.advisory.cvssScore !== null ? `${f.advisory.cvssScore.toFixed(1)} ${f.advisory.severity}` : f.advisory.severity;
    const reach = f.reachability.reachable ? `${c.green}yes${c.reset}` : `${c.dim}no${c.reset}`;
    const route = `${routeStyle[f.route]}${c.bold}${routeGlyph[f.route]}${c.reset}`;
    L.push(
      `  ${pad(pkg, 20)}${pad(adv, 20)}${pad(cvss, 12)}${pad(pct(f.epss), 9)}${pad(reach, 8)}${route}`,
    );
  }

  L.push("");
  L.push(`  ${c.bold}Evidence${c.reset}`);
  for (const f of report.findings) {
    L.push("");
    L.push(`  ${routeStyle[f.route]}${c.bold}${routeGlyph[f.route]}${c.reset}  ${c.white}${f.dependency.name}@${f.dependency.version}${c.reset}  ${c.dim}(risk ${f.riskScore}/100)${c.reset}`);
    L.push(`     ${c.dim}advisory${c.reset} ${f.advisory.id}${f.advisory.cve ? ` · ${f.advisory.cve}` : ""}${f.advisory.advisoryCount > 1 ? ` (+${f.advisory.advisoryCount - 1} more)` : ""}`);
    if (f.advisory.summary) L.push(`     ${c.dim}summary${c.reset}  ${f.advisory.summary}`);
    L.push(
      `     ${c.dim}severity${c.reset} CVSS ${f.advisory.cvssScore?.toFixed(1) ?? "?"} (${f.advisory.severity})   ${c.dim}exploit${c.reset} EPSS ${pct(f.epss)}${f.epssPercentile !== null ? ` (p${(f.epssPercentile * 100).toFixed(0)})` : ""}`,
    );
    if (f.reachability.reachable && f.reachability.reachablePath) {
      L.push(`     ${c.dim}reach${c.reset}    ${c.green}reachable${c.reset} via ${f.reachability.reachablePath.join(` ${c.dim}→${c.reset} `)}`);
    } else {
      L.push(`     ${c.dim}reach${c.reset}    ${c.dim}unreachable — 0 import sites across ${f.reachability.scannedFiles} files${c.reset}`);
    }
    if (f.advisory.fixedVersion) L.push(`     ${c.dim}fix${c.reset}      upgrade to ${f.dependency.name}@${f.advisory.fixedVersion}`);
    L.push(`     ${routeStyle[f.route]}${f.rationale}${c.reset}`);
  }

  const counts = report.findings.reduce<Record<string, number>>((a, f) => {
    a[f.route] = (a[f.route] ?? 0) + 1;
    return a;
  }, {});
  L.push("");
  L.push(`  ${c.bgline}${"─".repeat(78)}${c.reset}`);
  L.push(
    `  ${c.bold}Queue${c.reset}  ${c.cyan}${counts.FIX ?? 0} FIX${c.reset}   ${c.yellow}${counts.ESCALATE ?? 0} ESCALATE${c.reset}   ${c.dim}${counts.SKIP ?? 0} SKIP${c.reset}   ${c.dim}(${report.findings.length} findings)${c.reset}`,
  );
  L.push("");
  return L.join("\n");
}

/** Portfolio renderer for a multi-service fleet scan. */
export function renderFleet(report: FleetReport): string {
  const L: string[] = [];
  L.push("");
  L.push(`  ${c.bold}${c.white}SENTINEL${c.reset} ${c.dim}· fleet triage across ${report.summary.services} services${c.reset}`);
  L.push(
    `  ${c.cyan}${report.summary.FIX} FIX${c.reset}   ${c.yellow}${report.summary.ESCALATE} ESCALATE${c.reset}   ${c.dim}${report.summary.SKIP} SKIP${c.reset}   ${c.dim}(${report.summary.findings} findings)${c.reset}`,
  );
  L.push(`  ${c.bgline}${"─".repeat(78)}${c.reset}`);

  for (const s of report.services) {
    L.push("");
    L.push(`  ${c.bold}${c.white}▸ ${s.name}${c.reset}  ${c.dim}${s.repoUrl.replace("https://github.com/", "")}${c.reset}`);
    if (s.report.findings.length === 0) {
      L.push(`     ${c.dim}no advisories${c.reset}`);
      continue;
    }
    for (const f of s.report.findings) {
      const route = `${routeStyle[f.route]}${c.bold}${routeGlyph[f.route]}${c.reset}`;
      const reach = f.reachability.reachable ? `${c.green}reachable${c.reset}` : `${c.dim}unreachable${c.reset}`;
      L.push(
        `     ${route}  ${pad(f.dependency.name + "@" + f.dependency.version, 20)} ${pad(f.advisory.cve ?? f.advisory.id, 18)} ${pad("CVSS " + (f.advisory.cvssScore?.toFixed(1) ?? "?"), 10)} ${reach}`,
      );
    }
  }
  L.push("");
  return L.join("\n");
}
