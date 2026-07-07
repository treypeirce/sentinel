/**
 * Sentinel triage CLI.
 *
 *   node src/cli.ts [--target <path>] [--refresh] [--json]
 *
 * Scans the target repo, prints the triage queue with evidence, and writes a
 * machine-readable queue.json that the cockpit and agent runner consume.
 */
import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { triage } from "./triage.ts";
import { triageFleet } from "./fleet.ts";
import { render, renderFleet } from "./render.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const targetArg = arg("--target");
  const target = targetArg
    ? resolve(process.cwd(), targetArg)
    : resolve(ROOT, "..", "acme-payments");
  const refresh = has("--refresh");

  if (has("--fleet")) {
    const cfg = join(ROOT, "fleet.json");
    const fleet = await triageFleet(cfg, ROOT, refresh);
    if (has("--json")) process.stdout.write(JSON.stringify(fleet, null, 2) + "\n");
    else process.stdout.write(renderFleet(fleet));
    const out = join(ROOT, "fleet-queue.json");
    writeFileSync(out, JSON.stringify(fleet, null, 2));
    if (!has("--json")) process.stdout.write(`  \x1b[90mfleet queue written → ${out}\x1b[0m\n\n`);
    return;
  }

  const report = await triage(target, refresh);

  if (has("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(render(report));
  }

  const out = join(ROOT, "queue.json");
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (!has("--json")) {
    process.stdout.write(`  \x1b[90mqueue written → ${out}\x1b[0m\n\n`);
  }
}

main().catch((err) => {
  console.error("sentinel: triage failed:", err.message);
  process.exit(1);
});
