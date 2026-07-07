/**
 * Builds the remediation prompt for a FIX finding. The sequence is deliberately
 * strict: reproduce-first (a failing test proving the vuln is real), then the
 * minimal patch, then green, then keep the regression test — and stop. This is
 * what makes the agent's output trustworthy: the test is the proof, not the diff.
 */
import type { Finding } from "../types.ts";

export function buildFixPrompt(f: Finding): string {
  const dep = `${f.dependency.name}@${f.dependency.version}`;
  const fix = f.advisory.fixedVersion
    ? `${f.dependency.name}@${f.advisory.fixedVersion}`
    : "the patched version";
  const path = f.reachability.reachablePath?.join(" -> ") ?? "the application entrypoint";

  return `You are remediating ONE known vulnerability in this repository. Do only this, and follow the steps in order.

VULNERABILITY
- Package: ${dep}
- Advisory: ${f.advisory.id}${f.advisory.cve ? ` (${f.advisory.cve})` : ""} — ${f.advisory.summary}
- Reachable via: ${path}
- Clean upstream fix: upgrade to ${fix}

REQUIRED SEQUENCE (do not skip or reorder):
1. FIRST, write a test that reproduces the weakness and FAILS against the current code, proving the vulnerability is real. Add it alongside the existing tests.
2. Apply the MINIMAL fix: upgrade ${f.dependency.name} to ${fix} in package.json, and make the small code change the fix requires. (For jsonwebtoken specifically: explicitly restrict the accepted algorithms when verifying tokens.)
3. Run the full test suite until it is green. The reproduction test from step 1 must now pass.
4. Keep the reproduction test as a permanent regression test.

HARD CONSTRAINTS:
- Change ONLY what this fix needs. Do not touch unrelated code, CI workflows (.github/**), or the .cursor/ hooks.
- Do NOT merge, do NOT force-push, do NOT rewrite git history. Stop once the fix is complete and tests pass.
- If you cannot make the reproduction test fail against the current code, say so and stop — do not invent a fix.

Summarize what you changed and why at the end.`;
}
