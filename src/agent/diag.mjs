// Diagnostic: does this key run a LOCAL agent, or is agent access plan-gated?
import { Agent } from "@cursor/sdk";

const apiKey = process.env.CURSOR_API_KEY;
console.log(`key: length ${apiKey?.length}, prefix ${apiKey?.slice(0, 8)}…`);

const model = process.env.SENTINEL_MODEL ?? "auto";
try {
  console.log(`creating LOCAL agent (model=${model}) …`);
  const agent = await Agent.create({ apiKey, model: { id: model }, local: { cwd: "/tmp" } });
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
