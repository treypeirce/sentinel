// Debug probe: dispatch the reviewer agent directly and dump raw events + result.
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) { console.error("no key"); process.exit(1); }

const prompt = `You are a senior security reviewer. READ ONLY: do not modify code, do not push, do not open PRs.
Steps:
1. Run: git fetch origin pull/1/head:prhead
2. Run: git diff main...prhead  (read the changed files for context if needed)
3. Review the change as a security fix.
Output EXACTLY this format, max 120 words total:
VERDICT: APPROVE   (or: VERDICT: REQUEST CHANGES)
- correctness: <one line>
- test: <one line>
- risk: <one line>`;

const agent = await Agent.create({
  apiKey,
  model: { id: process.env.SENTINEL_MODEL ?? "composer-2.5" },
  cloud: { repos: [{ url: "https://github.com/treypeirce/acme-billing", startingRef: "main" }], autoCreatePR: true },
});
console.log("agent:", agent.agentId ?? "(no id)");
const run = await agent.send(prompt);
let n = 0;
for await (const ev of run.stream()) {
  n++;
  const t = ev?.type ?? "?";
  const snippet = JSON.stringify(ev).slice(0, 300);
  console.log(`EV[${n}] type=${t} :: ${snippet}`);
}
const result = await run.wait().catch((e) => ({ waitError: String(e?.message ?? e) }));
console.log("RESULT:", JSON.stringify(result, null, 2).slice(0, 2500));
