// Diagnostic: does this key run a LOCAL agent, or is agent access plan-gated?
import { Agent, Cursor } from "@cursor/sdk";
import { planModelRoute, resolveModelRoute, routingSummary } from "./modelRouting.ts";

const apiKey = process.env.CURSOR_API_KEY;
console.log(`key: ${apiKey ? `present (length ${apiKey.length})` : "missing"}`);

if (!apiKey) process.exit(2);
const route = resolveModelRoute(planModelRoute("fix"), await Cursor.models.list({ apiKey }));
if (!route.selection) { console.error("routing blocked:", route.receipt.blockedReason); process.exit(2); }
try {
  console.log(`creating LOCAL agent (${routingSummary(route.receipt)}) …`);
  const agent = await Agent.create({ apiKey, model: route.selection, local: { cwd: "/tmp" } });
  console.log(`local agent created: ${agent.agentId ?? "(ok)"}`);
  const run = await agent.send("Reply with exactly: PING-OK. Do not use any tools.");
  for await (const _ev of run.stream()) {
    /* drain */
  }
  const res = await run.wait().catch(() => null);
  console.log(`run status: ${res?.status ?? "?"}  result: ${(res?.result ?? "").toString().slice(0, 80)}`);
  await agent.close?.();
  console.log("LOCAL AGENT: OK");
} catch (e) {
  console.error("LOCAL AGENT ERROR:", e?.message ?? e);
  process.exit(1);
}
