// Cloud smoke test: start a CLOUD agent to fix the jsonwebtoken vuln on the
// real repo with autoCreatePR, confirm it starts, then exit (the agent keeps
// running on Cursor's infra and opens a PR). Hard 40s cap so we never hang.
import { Agent, Cursor } from "@cursor/sdk";
import { planModelRoute, resolveModelRoute, routingSummary } from "./modelRouting.ts";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) { console.error("no CURSOR_API_KEY"); process.exit(2); }
const repoUrl = process.env.REPO ?? "https://github.com/treypeirce/acme-payments";
const route = resolveModelRoute(planModelRoute("fix"), await Cursor.models.list({ apiKey }));
if (!route.selection) { console.error("routing blocked:", route.receipt.blockedReason); process.exit(2); }

const PROMPT = `Remediate ONE known vulnerability. Package: jsonwebtoken@8.5.1 (CVE-2022-23539) — weak token verification. It is used by requireAuth in src/middleware/auth.ts, on every protected route.
Steps in order:
1. FIRST add a test that reproduces the weakness and FAILS on the current code.
2. Upgrade jsonwebtoken to ^9.0.0 in package.json and restrict verify() to { algorithms: ["HS256"] } in src/middleware/auth.ts.
3. Run the test suite until green; keep the reproduction test as a regression test.
Change only what this fix needs. Do not touch .github/** or .cursor/**. Do not merge.`;

const cap = setTimeout(() => {
  console.log("\n[40s cap] agent is still running on Cursor's infra; it will open a PR when done.");
  process.exit(0);
}, 40000);

try {
  console.log(`create CLOUD agent · ${repoUrl} · ${routingSummary(route.receipt)}`);
  const agent = await Agent.create({
    apiKey,
    model: route.selection,
    cloud: { repos: [{ url: repoUrl, startingRef: process.env.REF ?? "main" }], autoCreatePR: true },
  });
  console.log("agentId:", agent.agentId);
  const run = await agent.send(PROMPT);
  console.log("run started; streaming status…");
  for await (const ev of run.stream()) {
    if (ev?.type === "status") console.log("  status:", ev.status ?? ev.state ?? JSON.stringify(ev).slice(0, 120));
    else if (ev?.type === "error" || ev?.type === "run_error") console.log("  ERROR:", JSON.stringify(ev).slice(0, 300));
  }
  clearTimeout(cap);
  const res = await run.wait().catch((e) => ({ status: "threw", error: e?.message }));
  const pr = res?.git?.branches?.[0]?.prUrl;
  console.log("final status:", res?.status, "PR:", pr ?? "(none yet)");
  process.exit(0);
} catch (e) {
  clearTimeout(cap);
  console.error("CLOUD ERROR:", e?.message ?? e);
  process.exit(1);
}
