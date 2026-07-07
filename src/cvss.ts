/**
 * CVSS v3.0/3.1 base-score calculator.
 *
 * Deterministic: given a CVSS vector string, computes the base score per the
 * official FIRST specification. No network, no dependencies.
 */

const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 } as const;
const AC = { L: 0.77, H: 0.44 } as const;
const UI = { N: 0.85, R: 0.62 } as const;
const CIA = { H: 0.56, L: 0.22, N: 0.0 } as const;
const PR_UNCHANGED = { N: 0.85, L: 0.62, H: 0.27 } as const;
const PR_CHANGED = { N: 0.85, L: 0.68, H: 0.5 } as const;

function roundUp1(input: number): number {
  const i = Math.round(input * 100000);
  if (i % 10000 === 0) return i / 100000;
  return (Math.floor(i / 10000) + 1) / 10;
}

export function severityFromScore(score: number): string {
  if (score <= 0) return "NONE";
  if (score < 4) return "LOW";
  if (score < 7) return "MEDIUM";
  if (score < 9) return "HIGH";
  return "CRITICAL";
}

/** Parse a CVSS vector (e.g. "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"). */
export function scoreFromVector(vector: string): number | null {
  const parts = vector.split("/").reduce<Record<string, string>>((acc, kv) => {
    const [k, v] = kv.split(":");
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  const av = AV[parts.AV as keyof typeof AV];
  const ac = AC[parts.AC as keyof typeof AC];
  const ui = UI[parts.UI as keyof typeof UI];
  const scope = parts.S; // U (unchanged) or C (changed)
  const pr =
    scope === "C"
      ? PR_CHANGED[parts.PR as keyof typeof PR_CHANGED]
      : PR_UNCHANGED[parts.PR as keyof typeof PR_UNCHANGED];
  const c = CIA[parts.C as keyof typeof CIA];
  const i = CIA[parts.I as keyof typeof CIA];
  const a = CIA[parts.A as keyof typeof CIA];

  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined) || !scope) {
    return null;
  }

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact =
    scope === "C"
      ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
      : 6.42 * iss;
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;
  const raw = scope === "C" ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundUp1(Math.min(raw, 10));
}

/** Representative score when only a qualitative severity is available. */
export function scoreFromQualitative(sev: string): number | null {
  switch (sev.toUpperCase()) {
    case "CRITICAL":
      return 9.8;
    case "HIGH":
      return 7.5;
    case "MEDIUM":
    case "MODERATE":
      return 5.5;
    case "LOW":
      return 3.1;
    default:
      return null;
  }
}
