/**
 * Cockpit server. Serves the cockpit and drives real cloud remediation runs.
 *
 *   export CURSOR_API_KEY="..."      # required for the live cloud run
 *   npm run cockpit                  # http://localhost:4317
 *
 * Endpoints:
 *   /                → the cockpit UI
 *   /api/health      → { ok, live } (live=true when a key is present)
 *   /api/queue       → the triage queue (queue.json)
 *   /api/run-cloud   → SSE: dispatches a REAL cloud agent (autoCreatePR),
 *                      streams its status live, ends with the real PR URL
 *   /api/stream      → SSE: replays the recorded run (the seatbelt)
 *
 * The cockpit HTML is self-contained and still works opened as a file (replay
 * only). The live cloud button appears only when this server reports a key.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planModelRoute,
  resolveModelRoute,
  withActualModel,
  type ModelRoutingReceipt,
  type ModelWorkKind,
  type PlannedModelRoute,
} from "../agent/modelRouting.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const PORT = Number(process.env.PORT ?? 4317);
const HOST = process.env.HOST ?? "127.0.0.1";
const REPO = process.env.REPO ?? "https://github.com/treypeirce/acme-payments";
const REF = process.env.REF ?? "main";

const FIX_PROMPT = `Remediate ONE known vulnerability. Package: jsonwebtoken@8.5.1 (CVE-2022-23539) — weak token verification, used by requireAuth in src/middleware/auth.ts on every protected route.
Steps in order:
1. FIRST add a test that reproduces the weakness and FAILS on the current code (forge a token with a different HMAC algorithm and show requireAuth accepts it).
2. Upgrade jsonwebtoken to ^9.0.0 in package.json and restrict verify() to { algorithms: ["HS256"] } in src/middleware/auth.ts.
3. Run the test suite until green; keep the reproduction test as a regression test.
Change only what this fix needs. Do not touch .github/** or .cursor/**. Do not merge.`;

/** Last PR opened per repo URL during this server session (live fleet runs update it). */
const LAST_PR: Record<string, string> = {};
const DEFAULT_REVIEW_PR = "https://github.com/treypeirce/acme-billing/pull/1";

let modelCatalogPromise: Promise<any[]> | null = null;
async function selectModel(workKind: ModelWorkKind, apiKey: string): Promise<PlannedModelRoute> {
  const planned = planModelRoute(workKind);
  if (!planned.selection) return planned;
  if (!modelCatalogPromise) {
    modelCatalogPromise = import("@cursor/sdk").then(({ Cursor }) => Cursor.models.list({ apiKey }));
  }
  try {
    return resolveModelRoute(planned, await modelCatalogPromise);
  } catch {
    modelCatalogPromise = null;
    return {
      receipt: {
        ...planned.receipt,
        status: "blocked",
        selectedModel: undefined,
        catalog: "unavailable",
        blockedReason: "Cursor model catalog could not be verified.",
      },
    };
  }
}

function emitRouting(
  emit: (o: unknown) => void,
  lane: string | undefined,
  receipt: ModelRoutingReceipt,
): void {
  emit({ ...(lane ? { lane } : {}), kind: "routing", receipt });
}

/** Investigator verdicts from the most recent investigation (memory + disk). */
const VERDICT_CACHE_PATH = () => join(ROOT, "investigation-cache.json");
let VERDICTS: Record<string, any> | null = null;
function loadVerdicts(): Record<string, any> | null {
  if (VERDICTS) return VERDICTS;
  try {
    if (existsSync(VERDICT_CACHE_PATH())) { VERDICTS = JSON.parse(readFileSync(VERDICT_CACHE_PATH(), "utf8")); return VERDICTS; }
  } catch { /* ignore */ }
  return null;
}

function investigatorPrompt(service: string): string {
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
    { "package": "name", "version": "installed version", "cve": "CVE or GHSA id or null",
      "verdict": "FIX" | "SKIP" | "ESCALATE", "reachable": true | false,
      "evidence": [ { "file": "path", "line": 12 | null, "note": "short note" } ],
      "reason": "one sentence, max 200 chars" }
  ]
}
\`\`\``;
}

function parseVerdictText(text: string): { ok: boolean; data?: any; why?: string } {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)];
  const raw = blocks.length ? blocks[blocks.length - 1][1] : String(text);
  try {
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.findings)) return { ok: false, why: "no findings array" };
    const enums = new Set(["FIX", "SKIP", "ESCALATE"]);
    for (const f of d.findings) if (!enums.has(f.verdict)) return { ok: false, why: "bad verdict enum" };
    return { ok: true, data: d };
  } catch (e: any) {
    return { ok: false, why: "json parse: " + e.message };
  }
}

function reviewPrompt(prNumber: number): string {
  return `You are a senior security reviewer. READ ONLY: do not modify code, do not push, do not open PRs.
Steps:
1. Run: git fetch origin pull/${prNumber}/head:prhead
2. Run: git diff main...prhead  (read the changed files for context if needed)
3. Review the change as a security fix.
Output EXACTLY this format, max 120 words total:
VERDICT: APPROVE   (or: VERDICT: REQUEST CHANGES)
- correctness: <one line on whether the fix actually closes the vulnerability>
- test: <one line on the quality of the regression test>
- risk: <one line on any remaining risk or follow-up>`;
}

function receiptOf(result: any, t0: number) {
  const durationMs = result?.durationMs ?? (Date.now() - t0);
  const tokens = result?.usage?.totalTokens;
  return { durationMs, tokens };
}

function parsePrUrl(prUrl: string): { owner: string; repo: string; num: number } | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], num: Number(m[3]) } : null;
}

async function postPrComment(prUrl: string, body: string): Promise<string | null> {
  const pat = process.env.GITHUB_PAT;
  const p = parsePrUrl(prUrl);
  if (!pat || !p) return null;
  const r = await fetch(`https://api.github.com/repos/${p.owner}/${p.repo}/issues/${p.num}/comments`, {
    method: "POST",
    headers: { authorization: `Bearer ${pat}`, accept: "application/vnd.github+json", "user-agent": "sentinel-cockpit" },
    body: JSON.stringify({ body }),
  });
  if (!r.ok) return null;
  const d = (await r.json()) as any;
  return d?.html_url ?? null;
}

/**
 * File a GitHub issue for an escalated service via the API. Low-risk by design:
 * - dedup: reuses an existing OPEN Sentinel issue in the repo instead of filing
 *   a new one each run (no spam across rehearsal + demo).
 * - returns null when GITHUB_PAT is missing or any call fails; the caller falls
 *   back to the static pre-filed issue link, so the demo never breaks.
 */
const ESC_TITLE_PREFIX = "[Sentinel] Security review required";
/** Per-repo issue URL filed this session: primary dedup (no API lag). */
const ISSUE_CACHE: Record<string, string> = {};
async function ensureEscalationIssue(repoUrl: string, findings: any[]): Promise<string | null> {
  if (ISSUE_CACHE[repoUrl]) return ISSUE_CACHE[repoUrl];
  const pat = process.env.GITHUB_PAT;
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!pat || !m) return null;
  const owner = m[1], repo = m[2];
  const headers = { authorization: `Bearer ${pat}`, accept: "application/vnd.github+json", "user-agent": "sentinel-cockpit" };
  try {
    const list = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=50`, { headers });
    if (list.ok) {
      const arr = (await list.json()) as any[];
      const existing = Array.isArray(arr) && arr.find((i) => typeof i?.title === "string" && i.title.startsWith(ESC_TITLE_PREFIX) && !i.pull_request);
      if (existing) { ISSUE_CACHE[repoUrl] = existing.html_url; return existing.html_url; }
    }
    const esc = findings.filter((f) => f.verdict === "ESCALATE");
    const lines = [
      "Sentinel routed the following finding(s) to human review (money-movement path, or the investigation was inconclusive). No code was changed.",
      "",
      ...esc.map((f) => `- **${f.package}${f.version ? "@" + f.version : ""}** (${f.cve ?? "advisory"}) — ${f.reason}`),
    ];
    for (const f of esc) for (const e of (f.evidence ?? [])) lines.push(`  - evidence: \`${e.file}${e.line ? ":" + e.line : ""}\`${e.note ? " · " + e.note : ""}`);
    lines.push("", "_Filed automatically by Sentinel. A human owns the decision._");
    const create = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: "POST", headers,
      body: JSON.stringify({ title: `${ESC_TITLE_PREFIX}: ${esc[0]?.package ?? "dependency"}`, body: lines.join("\n") }),
    });
    if (!create.ok) return null;
    const d = (await create.json()) as any;
    if (d?.html_url) ISSUE_CACHE[repoUrl] = d.html_url;
    return d?.html_url ?? null;
  } catch {
    return null;
  }
}

/** Dispatch an advisory reviewer agent for a PR and stream its work into a lane. */
async function runReviewer(lane: string, repoUrl: string, prUrl: string, emit: (o: unknown) => void): Promise<boolean> {
  const apiKey = process.env.CURSOR_API_KEY;
  const target = parsePrUrl(prUrl);
  if (!apiKey || !target) return false;
  const route = await selectModel("review", apiKey);
  emitRouting(emit, lane, route.receipt);
  if (!route.selection) {
    emit({ lane, kind: "status", text: `Reviewer blocked: ${route.receipt.blockedReason}` });
    emit({ lane, kind: "review", verdict: "blocked", text: route.receipt.blockedReason, prUrl, routing: route.receipt });
    return false;
  }
  const t0 = Date.now();
  const { Agent } = await import("@cursor/sdk");
  emit({ lane, kind: "status", text: `Dispatching REVIEWER agent for ${target.repo} PR #${target.num}…` });
  const agent = await Agent.create({
    apiKey, model: route.selection,
    cloud: { repos: [{ url: repoUrl, startingRef: "main" }], autoCreatePR: false },
  });
  emit({ lane, kind: "status", text: `Reviewer agent ${(agent as any).agentId ?? ""} dispatched · advisory only` });
  const run = await agent.send(reviewPrompt(target.num));
  for await (const ev of run.stream() as AsyncIterable<any>) {
    if (ev?.type === "status") emit({ lane, kind: "status", text: phaseLabel(ev.status ?? ev.state) });
    else if (ev?.type === "assistant") { const t = extractText(ev); if (t) emit({ lane, kind: "assistant", text: t }); }
    else if (ev?.type === "tool_call") emit({ lane, kind: "tool", tool: ev.tool ?? ev.name ?? "tool", detail: ev.detail ?? "" });
  }
  const result = (await run.wait().catch(() => null)) as any;
  const routed = withActualModel(route.receipt, result?.model);
  emitRouting(emit, lane, routed);
  const text = String(result?.result ?? "").trim();
  const verdict = /VERDICT:\s*APPROVE/i.test(text) ? "approve" : (/VERDICT:\s*REQUEST/i.test(text) ? "changes" : "review");
  let commentUrl: string | null = null;
  if (text) {
    const model = routed.sdkResolvedModel?.id ?? routed.selectedModel ?? routed.requestedModel;
    commentUrl = await postPrComment(prUrl, `**Sentinel · agent review of this PR**\n\n${text}\n\n_Posted automatically by the Sentinel reviewer agent (${model}). A human still owns the merge._`).catch(() => null);
  }
  emit({ lane, kind: "review", verdict, text, prUrl, commentUrl, durationMs: result?.durationMs ?? (Date.now() - t0), routing: routed });
  return true;
}

function sse(res: any) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  return (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function send(res: any, code: number, type: string, body: string) {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}
function extractText(ev: any): string {
  if (typeof ev.text === "string") return ev.text;
  const content = ev.message?.content ?? ev.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
  return "";
}
function phaseLabel(status: string): string {
  const s = String(status || "").toUpperCase();
  if (s === "CREATING") return "Provisioning an isolated cloud VM…";
  if (s === "RUNNING") return "Agent running on Cursor: cloning, reading, testing, patching…";
  if (s === "FINISHED") return "Run finished — opening pull request";
  if (s === "ERROR") return "Run errored";
  if (s === "CANCELLED") return "Run cancelled";
  if (s === "EXPIRED") return "Run expired";
  return status || "…";
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/" || url.startsWith("/fleet")) {
    const p = join(ROOT, "public", "fleet.html");
    if (!existsSync(p)) return send(res, 500, "text/plain", "Run `npm run cockpit:fleet` first.");
    return send(res, 200, "text/html", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/cockpit")) {
    const p = join(ROOT, "public", "cockpit.html");
    if (!existsSync(p)) return send(res, 500, "text/plain", "Run `npm run cockpit:build` first.");
    return send(res, 200, "text/html", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/arch")) {
    const p = join(ROOT, "public", "arch.html");
    if (!existsSync(p)) return send(res, 404, "text/plain", "arch.html not found");
    return send(res, 200, "text/html", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/api/fleet")) {
    const p = join(ROOT, "fleet-queue.json");
    if (!existsSync(p)) return send(res, 404, "application/json", "{}");
    return send(res, 200, "application/json", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/api/health")) {
    return send(res, 200, "application/json", JSON.stringify({ ok: true, live: !!process.env.CURSOR_API_KEY, verdicts: !!loadVerdicts(), repo: REPO }));
  }

  // Parallel advisory INVESTIGATION: one cloud agent per service decides the routes.
  if (url.startsWith("/api/investigate")) {
    const emit = sse(res);
    const apiKey = process.env.CURSOR_API_KEY;
    const fleetPath = join(ROOT, "fleet-queue.json");
    if (!apiKey || !existsSync(fleetPath)) {
      emit({ kind: "status", text: "Investigation unavailable: missing Cursor key or fleet manifest." });
      emit({ kind: "invdone", summary: { services: 0, findings: 0, FIX: 0, SKIP: 0, ESCALATE: 0, incomplete: true } });
      return res.end();
    }
    const fleet = JSON.parse(readFileSync(fleetPath, "utf8")) as any;
    const services = fleet.services as any[];
    (async () => {
      const { Agent } = await import("@cursor/sdk");
      const route = await selectModel("investigate", apiKey);
      emitRouting(emit, undefined, route.receipt);
      if (!route.selection) {
        emit({ kind: "status", text: `Investigation blocked: ${route.receipt.blockedReason}` });
        emit({ kind: "invdone", summary: { services: services.length, findings: 0, FIX: 0, SKIP: 0, ESCALATE: 0, incomplete: true } });
        res.write("event: end\ndata: {}\n\n");
        res.end();
        return;
      }
      const collected: Record<string, any> = {};

      async function investigateOnce(svc: any, attempt: number): Promise<any> {
        const lane = svc.name;
        const t0 = Date.now();
        emit({ lane, kind: "status", text: (attempt > 1 ? "retry · " : "") + `Dispatching advisory investigator to ${lane}…` });
        emitRouting(emit, lane, route.receipt);
        const agent = await Agent.create({
          apiKey, model: route.selection,
          cloud: { repos: [{ url: svc.repoUrl, startingRef: "main" }], autoCreatePR: false },
        });
        emit({ lane, kind: "status", text: `Investigator ${(agent as any).agentId ?? ""} · advisory · no automatic PR` });
        const run = await agent.send(investigatorPrompt(svc.name));
        for await (const ev of run.stream() as AsyncIterable<any>) {
          if (ev?.type === "status") emit({ lane, kind: "status", text: phaseLabel(ev.status ?? ev.state) });
          else if (ev?.type === "assistant") { const t = extractText(ev); if (t) emit({ lane, kind: "assistant", text: t }); }
          else if (ev?.type === "tool_call") emit({ lane, kind: "tool", tool: ev.tool ?? ev.name ?? "tool", detail: ev.detail ?? "" });
        }
        const result = (await run.wait().catch(() => null)) as any;
        const routed = withActualModel(route.receipt, result?.model);
        emitRouting(emit, lane, routed);
        const elapsed = Date.now() - t0;
        if (result?.status !== "finished") {
          if (attempt < 2 && elapsed < 30000) return investigateOnce(svc, attempt + 1); // transient infra flake: retry once
          return { failed: true, elapsed };
        }
        const parsed = parseVerdictText(result?.result ?? "");
        return { parsed, elapsed, durationMs: result?.durationMs ?? elapsed, routing: routed };
      }

      await Promise.all(services.map(async (svc: any) => {
        const lane = svc.name;
        try {
          const out = await investigateOnce(svc, 1);
          let findings: any[];
          if (out.failed || !out.parsed?.ok) {
            findings = [{ package: "(investigation inconclusive)", version: "", cve: null, verdict: "ESCALATE", reachable: null, evidence: [], reason: "Investigator returned no structured verdict; routed to a human by default." }];
          } else {
            findings = out.parsed.data.findings;
          }
          collected[svc.name] = { service: svc.name, repoUrl: svc.repoUrl, findings };
          const issueUrl = findings.some((f: any) => f.verdict === "ESCALATE")
            ? await ensureEscalationIssue(svc.repoUrl, findings).catch(() => null)
            : null;
          emit({ lane, kind: "verdict", service: svc.name, durationMs: out.durationMs ?? out.elapsed, findings, issueUrl, routing: out.routing ?? route.receipt });
        } catch (e: any) {
          const findings = [{ package: "(investigation error)", version: "", cve: null, verdict: "ESCALATE", reachable: null, evidence: [], reason: "Investigator error: routed to a human by default." }];
          collected[svc.name] = { service: svc.name, repoUrl: svc.repoUrl, findings };
          const issueUrl = await ensureEscalationIssue(svc.repoUrl, findings).catch(() => null);
          emit({ lane, kind: "verdict", service: svc.name, durationMs: 0, findings, issueUrl, routing: route.receipt });
        }
      }));

      const all = Object.values(collected).flatMap((s: any) => s.findings);
      const summary = {
        services: services.length, findings: all.length,
        FIX: all.filter((f: any) => f.verdict === "FIX").length,
        SKIP: all.filter((f: any) => f.verdict === "SKIP").length,
        ESCALATE: all.filter((f: any) => f.verdict === "ESCALATE").length,
      };
      VERDICTS = collected;
      try { writeFileSync(VERDICT_CACHE_PATH(), JSON.stringify(collected, null, 2)); } catch { /* ignore */ }
      emit({ kind: "invdone", summary });
      res.write("event: end\ndata: {}\n\n");
      res.end();
    })().catch(() => { try { res.end(); } catch { /* ignore */ } });
    return;
  }

  if (url.startsWith("/api/queue")) {
    const p = join(ROOT, "queue.json");
    if (!existsSync(p)) return send(res, 404, "application/json", "{}");
    return send(res, 200, "application/json", readFileSync(p, "utf8"));
  }

  // Replay (seatbelt)
  if (url.startsWith("/api/stream")) {
    const emit = sse(res);
    const run = JSON.parse(readFileSync(join(here, "mock-run.json"), "utf8"));
    const events: any[] = run.events;
    let i = 0;
    const tick = () => {
      if (i >= events.length) { res.write("event: end\ndata: {}\n\n"); return res.end(); }
      const e = events[i++];
      emit(e);
      setTimeout(tick, e.delay ?? 650);
    };
    tick();
    return;
  }

  // Live cloud remediation
  if (url.startsWith("/api/run-cloud")) {
    const emit = sse(res);
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      emit({ kind: "status", text: "No CURSOR_API_KEY on the server — start it with your key set." });
      emit({ kind: "done", status: "error" });
      return res.end();
    }
    (async () => {
      const t0 = Date.now();
      try {
        const { Agent } = await import("@cursor/sdk");
        const route = await selectModel("fix", apiKey);
        emitRouting(emit, undefined, route.receipt);
        if (!route.selection) {
          emit({ kind: "status", text: `Dispatch blocked: ${route.receipt.blockedReason}` });
          emit({ kind: "done", status: "blocked", routing: route.receipt });
          return;
        }
        emit({ kind: "status", text: `Dispatching cloud agent to ${REPO.split("/").slice(-2).join("/")}…` });
        emit({ kind: "plan", text: "Reproduce the weak JWT verification with a failing test, upgrade jsonwebtoken to 9, restrict verify() to HS256, prove green, and open a PR." });
        const agent = await Agent.create({
          apiKey,
          model: route.selection,
          cloud: { repos: [{ url: REPO, startingRef: REF }], autoCreatePR: true },
        });
        emit({ kind: "status", text: `Cloud agent ${(agent as any).agentId ?? ""} dispatched` });
        const run = await agent.send(FIX_PROMPT);
        for await (const ev of run.stream() as AsyncIterable<any>) {
          if (ev?.type === "status") emit({ kind: "status", text: phaseLabel(ev.status ?? ev.state) });
          else if (ev?.type === "assistant") { const t = extractText(ev); if (t) emit({ kind: "assistant", text: t }); }
          else if (ev?.type === "tool_call") emit({ kind: "tool", tool: ev.tool ?? ev.name ?? "tool", detail: ev.detail ?? "" });
        }
        const result = (await run.wait().catch(() => null)) as any;
        const routed = withActualModel(route.receipt, result?.model);
        emitRouting(emit, undefined, routed);
        const branch = result?.git?.branches?.[0]?.branch;
        const pr = result?.git?.branches?.[0]?.prUrl ?? result?.git?.branches?.[0]?.pr_url;
        if (pr) LAST_PR[REPO] = pr;
        emit({ kind: "done", status: result?.status ?? "complete", branch, prUrl: pr, ...receiptOf(result, t0), routing: routed });
      } catch (e: any) {
        emit({ kind: "status", text: "Live run error: " + (e?.message ?? e) });
        emit({ kind: "done", status: "error" });
      } finally {
        res.write("event: end\ndata: {}\n\n");
        res.end();
      }
    })();
    return;
  }

  // Live PARALLEL fleet remediation: dispatch a cloud agent per FIX service.
  if (url.startsWith("/api/run-fleet")) {
    const emit = sse(res);
    const apiKey = process.env.CURSOR_API_KEY;
    const fleetPath = join(ROOT, "fleet-queue.json");
    if (!apiKey || !existsSync(fleetPath)) {
      emit({ kind: "status", text: "No key or fleet-queue.json on the server." });
      emit({ kind: "done", status: "error" });
      return res.end();
    }
    const fleet = JSON.parse(readFileSync(fleetPath, "utf8")) as any;
    // Prefer investigator verdicts (the new brain); fall back to the old engine's routes.
    const verdicts = loadVerdicts();
    const fixServices = verdicts
      ? (fleet.services as any[]).filter((s) => verdicts[s.name]?.findings?.some((f: any) => f.verdict === "FIX"))
      : (fleet.services as any[]).filter((s) => s.report.findings.some((f: any) => f.route === "FIX"));
    (async () => {
      try {
        const { Agent } = await import("@cursor/sdk");
        const route = await selectModel("fix", apiKey);
        emitRouting(emit, undefined, route.receipt);
        if (!route.selection) {
          emit({ kind: "status", text: `Fleet dispatch blocked: ${route.receipt.blockedReason}` });
          emit({ kind: "done", status: "blocked", routing: route.receipt });
          return;
        }
        await Promise.all(
          fixServices.map(async (svc: any) => {
            const lane = svc.name;
            const t0 = Date.now();
            try {
              emit({ lane, kind: "status", text: `Dispatching cloud agent to ${lane}…` });
              emitRouting(emit, lane, route.receipt);
              const agent = await Agent.create({
                apiKey,
                model: route.selection,
                cloud: { repos: [{ url: svc.repoUrl, startingRef: REF }], autoCreatePR: true },
              });
              emit({ lane, kind: "status", text: `Cloud agent ${(agent as any).agentId ?? ""} dispatched` });
              const run = await agent.send(FIX_PROMPT);
              for await (const ev of run.stream() as AsyncIterable<any>) {
                if (ev?.type === "status") emit({ lane, kind: "status", text: phaseLabel(ev.status ?? ev.state) });
                else if (ev?.type === "assistant") { const t = extractText(ev); if (t) emit({ lane, kind: "assistant", text: t }); }
                else if (ev?.type === "tool_call") emit({ lane, kind: "tool", tool: ev.tool ?? ev.name ?? "tool", detail: ev.detail ?? "" });
              }
              const result = (await run.wait().catch(() => null)) as any;
              const routed = withActualModel(route.receipt, result?.model);
              emitRouting(emit, lane, routed);
              const prUrl = result?.git?.branches?.[0]?.prUrl;
              if (prUrl) LAST_PR[svc.repoUrl] = prUrl;
              emit({ lane, kind: "done", status: result?.status ?? "complete", prUrl, ...receiptOf(result, t0), routing: routed });
              // Review is part of the pipeline: every fix PR should get an advisory agent review.
              if (prUrl) {
                const reviewed = await runReviewer(lane, svc.repoUrl, prUrl, emit).catch((e: any) => {
                  emit({ lane, kind: "status", text: "reviewer error: " + (e?.message ?? e) });
                  return false;
                });
                if (!reviewed) emit({ lane, kind: "status", text: "Review incomplete — human review required before merge." });
              }
            } catch (e: any) {
              emit({ lane, kind: "status", text: "error: " + (e?.message ?? e) });
              emit({ lane, kind: "done", status: "error" });
            }
          }),
        );
      } finally {
        res.write("event: end\ndata: {}\n\n");
        res.end();
      }
    })();
    return;
  }

  // Reviewer agent: a cloud agent reviews a fix PR in advisory mode and, if a
  // GITHUB_PAT is set, its review is posted as a real comment on the PR.
  if (url.startsWith("/api/run-review")) {
    const emit = sse(res);
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      emit({ kind: "status", text: "No CURSOR_API_KEY on the server." });
      emit({ kind: "done", status: "error" });
      return res.end();
    }
    const billingRepo = "https://github.com/treypeirce/acme-billing";
    const prUrl = LAST_PR[billingRepo] ?? DEFAULT_REVIEW_PR;
    const target = parsePrUrl(prUrl);
    if (!target) {
      emit({ kind: "status", text: "No reviewable PR found." });
      emit({ kind: "done", status: "error" });
      return res.end();
    }
    const lane = "acme-billing";
    void target;
    (async () => {
      try {
        const reviewed = await runReviewer(lane, billingRepo, prUrl, emit);
        emit({ lane, kind: "done", status: reviewed ? "review-complete" : "review-blocked", noPr: true });
      } catch (e: any) {
        emit({ lane, kind: "status", text: "Reviewer error: " + (e?.message ?? e) });
        emit({ lane, kind: "done", status: "error", noPr: true });
      } finally {
        res.write("event: end\ndata: {}\n\n");
        res.end();
      }
    })();
    return;
  }

  send(res, 404, "text/plain", "not found");
});

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHosts.has(HOST) && process.env.SENTINEL_ALLOW_REMOTE !== "1") {
  throw new Error("Refusing to expose paid Sentinel run endpoints beyond loopback. Set SENTINEL_ALLOW_REMOTE=1 only in a protected demo network.");
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Sentinel cockpit → http://${HOST}:${PORT}   (live cloud run: ${process.env.CURSOR_API_KEY ? "enabled" : "set CURSOR_API_KEY to enable"})\n`);
});
