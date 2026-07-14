/**
 * Builds fleet-run.json (the recorded replay seatbelt) from REAL captured SSE
 * logs: an investigation capture + a fix/review capture. Every event in the
 * replay comes from an actual run; PR links are rewritten to the canonical
 * open PRs so replay clicks land on real, open artifacts.
 *
 *   node src/cockpit/record-replay.mjs /tmp/inv.log /tmp/fleet.log
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [invPath, fleetPath] = process.argv.slice(2);
if (!invPath || !fleetPath) { console.error("usage: record-replay.mjs <inv.log> <fleet.log>"); process.exit(1); }

const CANON_PR = {
  "acme-payments": "https://github.com/treypeirce/acme-payments/pull/1",
  "acme-billing": "https://github.com/treypeirce/acme-billing/pull/1",
};
const ISSUES = { "acme-ledger": "https://github.com/treypeirce/acme-ledger/issues/1" };

function parseSse(path) {
  return readFileSync(path, "utf8").split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

/** Coalesce consecutive assistant token events per lane into sentences. */
function coalesce(events) {
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.kind === "assistant" && last && last.kind === "assistant" && last.lane === e.lane) {
      last.text += e.text;
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

function trimLane(events, lane, opts) {
  const laneEvents = events.filter((e) => e.lane === lane);
  const kept = [];
  let statusCount = 0, toolCount = 0, lastToolKey = "";
  for (const e of laneEvents) {
    if (e.kind === "status") {
      if (statusCount >= opts.maxStatus) continue;
      if (kept.length && kept[kept.length - 1].kind === "status" && kept[kept.length - 1].text === e.text) continue;
      statusCount++; kept.push(e);
    } else if (e.kind === "tool") {
      const key = (e.tool ?? "") + "|" + (e.detail ?? "");
      if (key === lastToolKey) continue;
      lastToolKey = key;
      if (toolCount >= opts.maxTool) continue;
      toolCount++; kept.push(e);
    } else if (e.kind === "assistant") {
      const t = String(e.text ?? "").trim();
      if (!opts.keepAssistant || t.length < 60) continue;
      kept.push({ ...e, text: t.length > 200 ? t.slice(0, 197) + "…" : t });
    } else if (["routing", "verdict", "test", "plan", "done", "review"].includes(e.kind)) {
      kept.push(e);
    }
  }
  return kept;
}

function interleave(lanesEvents, baseDelay) {
  // round-robin across lanes to look parallel
  const queues = lanesEvents.map((l) => [...l]);
  const out = [];
  let i = 0;
  while (queues.some((q) => q.length)) {
    const q = queues[i % queues.length];
    if (q.length) {
      const e = q.shift();
      out.push({ ...e, delay: baseDelay + ((out.length * 37) % 260) });
    }
    i++;
  }
  return out;
}

// ---- investigation phase ----
const invRaw = coalesce(parseSse(invPath));
const invLanes = [...new Set(invRaw.filter((e) => e.lane).map((e) => e.lane))];
const invTrimmed = invLanes.map((lane) => trimLane(invRaw, lane, { maxStatus: 3, maxTool: 4, keepAssistant: false }));
let timeline = interleave(invTrimmed, 520);
const invdone = invRaw.find((e) => e.kind === "invdone");
if (invdone) timeline.push({ ...invdone, delay: 700 });

// ---- fix + review phase ----
const fleetRaw = coalesce(parseSse(fleetPath));
const fleetLanes = [...new Set(fleetRaw.filter((e) => e.lane).map((e) => e.lane))];
const fleetTrimmed = fleetLanes.map((lane) =>
  trimLane(fleetRaw, lane, { maxStatus: 4, maxTool: 8, keepAssistant: true }).map((e) => {
    if (e.kind === "done" && e.prUrl && CANON_PR[lane]) return { ...e, prUrl: CANON_PR[lane] };
    if (e.kind === "review") return { ...e, prUrl: CANON_PR[lane] ?? e.prUrl, commentUrl: e.commentUrl ?? null };
    return e;
  }),
);
timeline = timeline.concat(interleave(fleetTrimmed, 620));

const models = [...new Set(timeline
  .filter((event) => event.kind === "routing")
  .map((event) => event.receipt?.sdkResolvedModel?.id ?? event.receipt?.selectedModel)
  .filter(Boolean))];
const out = {
  meta: {
    mode: "recorded",
    model: models.length === 1 ? models[0] : (models.length ? "mixed" : "not recorded"),
    models,
    note: "Recorded from real runs: parallel investigation, parallel fixes, automatic agent reviews.",
    artifacts: { prs: CANON_PR, issues: ISSUES },
  },
  timeline,
};
const dest = join(here, "fleet-run.json");
writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`replay recorded → ${dest} (${timeline.length} events, ~${Math.round(timeline.reduce((a, e) => a + (e.delay ?? 600), 0) / 1000)}s playback)`);
