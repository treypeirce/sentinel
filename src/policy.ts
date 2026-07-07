/**
 * Escalation policy — the "extend it live" surface.
 *
 * Each rule is a small pure predicate over a finding's import sites. If any
 * rule matches a *reachable* finding, it is ESCALATED to a human instead of
 * auto-fixed. Adding a rule is a ~5-line change; the queue re-routes on the
 * next run with no other code touched.
 *
 * Precedence: rules are evaluated top to bottom; the first match wins.
 */
export interface SensitiveRule {
  name: string;
  description: string;
  match: (importSites: string[]) => boolean;
}

const onPath = (sites: string[], re: RegExp) => sites.some((f) => re.test(f));

export const sensitiveRules: SensitiveRule[] = [
  {
    name: "money-movement",
    description: "code on the settlement / money-movement path (src/payments, src/ledger, src/settlement)",
    match: (sites) => onPath(sites, /(^|\/)src\/(payments|ledger|settlement)\//),
  },
  // Add rules live during the demo, e.g.:
  // {
  //   name: "auth-surface",
  //   description: "code on the authentication path (src/auth/**, auth middleware)",
  //   match: (sites) => onPath(sites, /(^|\/)src\/(auth\/|middleware\/auth)/),
  // },
];

export function matchSensitive(importSites: string[]): SensitiveRule | null {
  return sensitiveRules.find((r) => r.match(importSites)) ?? null;
}
