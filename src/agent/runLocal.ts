/**
 * Local agent runner — the on-stage FIX loop.
 *
 * Runs Sentinel's triage, takes the top FIX finding, and drives a LOCAL Cursor
 * agent (in-process, fast, no VM spin-up) through reproduce -> patch -> green
 * on a working copy. Streams the agent's activity live. Never merges.
 *
 * Run it with the key injected:
 *   RunWithCredentials(skillName="Cursor Agent Key",
 *     command="node /agent/workspace/sentinel/src/agent/runLocal.ts --target <working-copy>")
 */
import { Agent } from "@cursor/sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { triage } from "../triage.ts";
import { buildFixPrompt } from "./prompt.ts";
import { renderEvent } from "./events.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error(
      "CURSOR_API_KEY not set. Run via RunWithCredentials(skillName='Cursor Agent Key', ...).",
    );
    process.exit(2);
  }

  const target = resolve(process.cwd(), arg("--target") ?? resolve(ROOT, "..", "acme-payments"));
  const model = process.env.SENTINEL_MODEL ?? "composer-2.5";

  console.log(`\n  SENTINEL · agent runner (local)`);
  console.log(`  target ${target}`);
  console.log(`  model  ${model}\n`);

  const report = await triage(target);
  const fixes = report.findings.filter((f) => f.route === "FIX");
  if (fixes.length === 0) {
    console.log("  No FIX findings — nothing for the agent to do.\n");
    return;
  }
  const finding = fixes[0];
  console.log(
    `  Remediating ${finding.dependency.name}@${finding.dependency.version} ` +
      `(${finding.advisory.cve ?? finding.advisory.id}) → upgrade to ${finding.advisory.fixedVersion}\n`,
  );

  const agent = await Agent.create({ apiKey, model: { id: model }, local: { cwd: target } });
  const run = await agent.send(buildFixPrompt(finding));

  for await (const event of run.stream() as AsyncIterable<any>) {
    renderEvent(event);
  }

  try {
    const result = (await run.wait()) as any;
    console.log(
      `\n\n  done — status ${result?.status ?? "?"}` +
        (result?.durationMs ? `, ${Math.round(result.durationMs / 1000)}s` : ""),
    );
    const u = result?.usage;
    if (u) console.log(`  tokens: ${u.totalTokens ?? "?"} (in ${u.inputTokens ?? "?"}, out ${u.outputTokens ?? "?"})`);
  } catch {
    console.log("\n  (run finished; final result unavailable)");
  }

  try {
    await (agent as any).close?.();
  } catch {
    /* ignore */
  }
  console.log("  Review the working-copy diff, then open a PR when you're satisfied.\n");
}

main().catch((err) => {
  console.error("runLocal failed:", err?.message ?? err);
  process.exit(1);
});
