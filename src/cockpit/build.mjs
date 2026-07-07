/**
 * Builds a self-contained cockpit (public/cockpit.html) by injecting the real
 * triage queue (queue.json) and the recorded remediation run (mock-run.json)
 * into the template. The result needs no server and no network — it IS the
 * replay seatbelt. Run `npm run triage` first to produce queue.json.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

const template = readFileSync(join(here, "template.html"), "utf8");
const run = readFileSync(join(here, "mock-run.json"), "utf8");

const queuePath = join(ROOT, "queue.json");
if (!existsSync(queuePath)) {
  console.error("queue.json not found — run `npm run triage` first.");
  process.exit(1);
}
const queue = readFileSync(queuePath, "utf8");

const html = template
  .replace("__QUEUE_JSON__", queue.trim())
  .replace("__RUN_JSON__", run.trim());

const outDir = join(ROOT, "public");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const out = join(outDir, "cockpit.html");
writeFileSync(out, html);
console.log(`cockpit built → ${out} (${Math.round(html.length / 1024)} KB)`);
