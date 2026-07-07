/**
 * Builds the self-contained fleet cockpit (public/fleet.html) by injecting the
 * portfolio (fleet-queue.json) and the recorded parallel run (fleet-run.json).
 * Run `npm run triage -- --fleet` first to produce fleet-queue.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

const template = readFileSync(join(here, "template-fleet.html"), "utf8");
const run = readFileSync(join(here, "fleet-run.json"), "utf8");

const fleetPath = join(ROOT, "fleet-queue.json");
if (!existsSync(fleetPath)) {
  console.error("fleet-queue.json not found — run `npm run triage -- --fleet` first.");
  process.exit(1);
}
const fleet = readFileSync(fleetPath, "utf8");

const html = template.replace("__FLEET_JSON__", fleet.trim()).replace("__RUN_JSON__", run.trim());
const outDir = join(ROOT, "public");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "fleet.html"), html);
console.log(`fleet cockpit built → ${join(outDir, "fleet.html")} (${Math.round(html.length / 1024)} KB)`);
