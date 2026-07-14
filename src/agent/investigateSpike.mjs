// Spike: dispatch advisory INVESTIGATOR agents across the fleet in parallel.
// Each investigates its own repo and must return a strict JSON verdict.
// Usage: node src/agent/investigateSpike.mjs
import { Agent, Cursor } from "@cursor/sdk";
import { planModelRoute, resolveModelRoute, routingSummary, withActualModel } from "./modelRouting.ts";
import { writeFileSync } from "node:fs";

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) { console.error("no key"); process.exit(1); }
const route = resolveModelRoute(planModelRoute("investigate"), await Cursor.models.list({ apiKey }));
if (!route.selection) { console.error("routing blocked:", route.receipt.blockedReason); process.exit(2); }
console.log("routing:", routingSummary(route.receipt));

const FLEET = [
  { name: "acme-payments", url: "https://github.com/treypeirce/acme-payments" },
  { name: "acme-billing", url: "https://github.com/treypeirce/acme-billing" },
  { name: "acme-notifications", url: "https://github.com/treypeirce/acme-notifications" },
  { name: "acme-ledger", url: "https://github.com/treypeirce/acme-ledger" },
];

function investigatorPrompt(service) {
  return `You are a READ-ONLY security investigator for the "${service}" service (this repository). Make NO code changes. Do not push. Do not open PRs.

Investigate like an engineer:
1. Find the vulnerable dependencies. Run \`npm audit --json\` (if it needs a lockfile, run \`npm install --package-lock-only\` first). Cross-check with package.json.
2. Pick the up-to-3 most significant vulnerable packages.
3. For EACH one, determine whether this service ACTUALLY USES it: search src/ for import/require of the package, and check whether the importing file is wired into the running app starting from src/index.ts.
4. Apply policy:
   - If the vulnerable package's usage sits under src/payments/, src/ledger/, or src/settlement/ (money movement), verdict = ESCALATE (a human must decide), regardless of fixability.
   - If the package is declared in package.json but never imported anywhere in src/, verdict = SKIP (cite the proof: what you searched).
   - If it is used, a fixed version exists, and it is not on a money path, verdict = FIX.
   - If you are unsure, verdict = ESCALATE.

Your FINAL message must be ONLY one fenced json block, exactly this schema, no prose before or after:
\`\`\`json
{
  "service": "${service}",
  "findings": [
    {
      "package": "name",
      "version": "installed version",
      "cve": "CVE id or GHSA id or null",
      "verdict": "FIX" | "SKIP" | "ESCALATE",
      "reachable": true | false,
      "evidence": [ { "file": "path", "line": 12 | null, "note": "short note" } ],
      "reason": "one sentence, max 200 chars"
    }
  ]
}
\`\`\``;
}

function parseVerdict(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : String(text);
  try {
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.findings)) return { ok: false, why: "no findings array", raw: String(text).slice(0, 400) };
    const enums = new Set(["FIX", "SKIP", "ESCALATE"]);
    for (const f of d.findings) if (!enums.has(f.verdict)) return { ok: false, why: "bad verdict enum: " + f.verdict, raw: "" };
    return { ok: true, data: d };
  } catch (e) {
    return { ok: false, why: "json parse: " + e.message, raw: String(text).slice(0, 400) };
  }
}

async function investigate(svc) {
  const t0 = Date.now();
  try {
    const agent = await Agent.create({
      apiKey, model: route.selection,
      cloud: { repos: [{ url: svc.url, startingRef: "main" }], autoCreatePR: false },
    });
    const run = await agent.send(investigatorPrompt(svc.name));
    let events = 0;
    for await (const _ of run.stream()) events++;
    const result = await run.wait().catch((e) => ({ status: "error", error: { message: String(e?.message ?? e) } }));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (result?.status !== "finished") return { svc: svc.name, ok: false, secs, why: "run " + (result?.status) + " " + (result?.error?.message ?? "") };
    const parsed = parseVerdict(result.result ?? "");
    const pr = result?.git?.branches?.[0]?.prUrl;
    return { svc: svc.name, ok: parsed.ok, secs, events, pr: pr ?? null, why: parsed.ok ? null : parsed.why, data: parsed.ok ? parsed.data : null, rawTail: parsed.ok ? null : parsed.raw, routing: withActualModel(route.receipt, result?.model) };
  } catch (e) {
    return { svc: svc.name, ok: false, secs: Math.round((Date.now() - t0) / 1000), why: "exception: " + (e?.message ?? e) };
  }
}

const results = await Promise.all(FLEET.map(investigate));
writeFileSync("/tmp/spike-results.json", JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n=== ${r.svc} · ${r.ok ? "PARSED OK" : "FAILED"} · ${r.secs}s · pr:${r.pr ?? "none"}`);
  if (r.ok) for (const f of r.data.findings) {
    console.log(`  ${f.verdict}  ${f.package}@${f.version}  reachable=${f.reachable}  cve=${f.cve}`);
    for (const e of (f.evidence ?? []).slice(0, 3)) console.log(`    evi: ${e.file}:${e.line ?? "-"} · ${e.note}`);
    console.log(`    reason: ${f.reason}`);
  } else console.log(`  why: ${r.why}\n  raw: ${(r.rawTail ?? "").slice(0, 250)}`);
}
console.log("\nSUMMARY:", results.map((r) => `${r.svc}=${r.ok ? "ok" : "FAIL"}(${r.secs}s)`).join("  "));
