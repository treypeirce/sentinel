/**
 * Cloud agent kickoff — the background PR.
 *
 * Starts a CLOUD Cursor agent against the real GitHub repo with autoCreatePR,
 * streams its status, and prints the PR URL when it lands. Designed to be
 * launched in a side terminal at the START of the demo so the PR is ready to
 * show ~15-20 minutes later, with the cloud latency happening underneath the
 * talk instead of blocking it.
 *
 *   RunWithCredentials(skillName="Cursor Agent Key",
 *     command="node /agent/workspace/sentinel/src/agent/kickoffCloud.ts --repo https://github.com/treypeirce/acme-payments")
 *
 * Prereq: the GitHub repo must be connected to the Cursor account so the cloud
 * agent can clone it and open a PR.
 */
import { Agent, Cursor } from "@cursor/sdk";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { triage } from "../triage.ts";
import { buildFixPrompt } from "./prompt.ts";
import { renderEvent } from "./events.ts";
import { planModelRoute, resolveModelRoute, withActualModel } from "./modelRouting.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("CURSOR_API_KEY not set. Run via RunWithCredentials(skillName='Cursor Agent Key', ...).");
    process.exit(2);
  }

  const repoUrl = arg("--repo") ?? "https://github.com/treypeirce/acme-payments";
  // Pick the FIX finding from a local scan (the cloud agent fixes it in its own clone).
  const localTarget = resolve(process.cwd(), arg("--target") ?? resolve(ROOT, "..", "acme-payments"));
  const route = resolveModelRoute(
    planModelRoute("fix"),
    await Cursor.models.list({ apiKey }),
  );
  renderEvent({ type: "routing", receipt: route.receipt });
  if (!route.selection) {
    console.error(`Model routing blocked: ${route.receipt.blockedReason}`);
    process.exit(2);
  }

  const report = await triage(localTarget);
  const finding = report.findings.find((f) => f.route === "FIX");
  if (!finding) {
    console.log("  No FIX findings — nothing to dispatch to the cloud.\n");
    return;
  }

  console.log(`\n  SENTINEL · cloud kickoff`);
  console.log(`  repo   ${repoUrl}`);
  console.log(`  fixing ${finding.dependency.name}@${finding.dependency.version} → ${finding.advisory.fixedVersion}\n`);

  const agent = await Agent.create({
    apiKey,
    model: route.selection,
    cloud: { repos: [{ url: repoUrl }], autoCreatePR: true },
  });
  console.log(`  cloud agent: ${(agent as any).agentId ?? "(started)"}  — keep this terminal open\n`);

  const run = await agent.send(buildFixPrompt(finding));
  for await (const event of run.stream() as AsyncIterable<any>) {
    renderEvent(event);
  }

  try {
    const result = (await run.wait()) as any;
    renderEvent({ type: "routing", receipt: withActualModel(route.receipt, result?.model) });
    const pr = result?.git?.branches?.[0]?.prUrl ?? result?.git?.branches?.[0]?.pr_url;
    const branch = result?.git?.branches?.[0]?.branch;
    console.log(`\n\n  done — status ${result?.status ?? "?"}${branch ? `, branch ${branch}` : ""}`);
    console.log(pr ? `  ✅ PR opened: ${pr}` : `  finished — check ${repoUrl}/pulls for the PR`);
  } catch (e) {
    console.log(`\n  run finished; check ${repoUrl}/pulls for the PR`);
  }
}

main().catch((err) => {
  console.error("kickoffCloud failed:", err?.message ?? err);
  process.exit(1);
});
