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
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const PORT = Number(process.env.PORT ?? 4317);
const REPO = process.env.REPO ?? "https://github.com/treypeirce/acme-payments";
const REF = process.env.REF ?? "main";
const MODEL = process.env.SENTINEL_MODEL ?? "composer-2.5";

const FIX_PROMPT = `Remediate ONE known vulnerability. Package: jsonwebtoken@8.5.1 (CVE-2022-23539) — weak token verification, used by requireAuth in src/middleware/auth.ts on every protected route.
Steps in order:
1. FIRST add a test that reproduces the weakness and FAILS on the current code (forge a token with a different HMAC algorithm and show requireAuth accepts it).
2. Upgrade jsonwebtoken to ^9.0.0 in package.json and restrict verify() to { algorithms: ["HS256"] } in src/middleware/auth.ts.
3. Run the test suite until green; keep the reproduction test as a regression test.
Change only what this fix needs. Do not touch .github/** or .cursor/**. Do not merge.`;

/** Last PR opened per repo URL during this server session (live fleet runs update it). */
const LAST_PR: Record<string, string> = {};
const DEFAULT_REVIEW_PR = "https://github.com/treypeirce/acme-billing/pull/1";

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
    return send(res, 200, "application/json", JSON.stringify({ ok: true, live: !!process.env.CURSOR_API_KEY, repo: REPO }));
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
        emit({ kind: "status", text: `Dispatching cloud agent to ${REPO.split("/").slice(-2).join("/")}…` });
        emit({ kind: "plan", text: "Reproduce the weak JWT verification with a failing test, upgrade jsonwebtoken to 9, restrict verify() to HS256, prove green, and open a PR." });
        const agent = await Agent.create({
          apiKey,
          model: { id: MODEL },
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
        const branch = result?.git?.branches?.[0]?.branch;
        const pr = result?.git?.branches?.[0]?.prUrl ?? result?.git?.branches?.[0]?.pr_url;
        if (pr) LAST_PR[REPO] = pr;
        emit({ kind: "done", status: result?.status ?? "complete", branch, prUrl: pr, ...receiptOf(result, t0) });
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
    const fixServices = (fleet.services as any[]).filter((s) => s.report.findings.some((f: any) => f.route === "FIX"));
    (async () => {
      try {
        const { Agent } = await import("@cursor/sdk");
        await Promise.all(
          fixServices.map(async (svc: any) => {
            const lane = svc.name;
            const t0 = Date.now();
            try {
              emit({ lane, kind: "status", text: `Dispatching cloud agent to ${lane}…` });
              const agent = await Agent.create({
                apiKey,
                model: { id: MODEL },
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
              const prUrl = result?.git?.branches?.[0]?.prUrl;
              if (prUrl) LAST_PR[svc.repoUrl] = prUrl;
              emit({ lane, kind: "done", status: result?.status ?? "complete", prUrl, ...receiptOf(result, t0) });
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

  // Reviewer agent: a cloud agent reviews a fix PR (read-only) and, if a
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
    (async () => {
      const t0 = Date.now();
      try {
        const { Agent } = await import("@cursor/sdk");
        emit({ lane, kind: "status", text: `Dispatching REVIEWER agent for ${target.repo} PR #${target.num}…` });
        // Note: autoCreatePR must be present for cloud runs (runs die with
        // stream_unavailable without it). The reviewer makes no changes, so no
        // PR is ever created; the read-only prompt is respected (verified).
        const agent = await Agent.create({
          apiKey,
          model: { id: MODEL },
          cloud: { repos: [{ url: billingRepo, startingRef: "main" }], autoCreatePR: true },
        });
        emit({ lane, kind: "status", text: `Reviewer agent ${(agent as any).agentId ?? ""} dispatched · read-only` });
        const run = await agent.send(reviewPrompt(target.num));
        for await (const ev of run.stream() as AsyncIterable<any>) {
          if (ev?.type === "status") emit({ lane, kind: "status", text: phaseLabel(ev.status ?? ev.state) });
          else if (ev?.type === "assistant") { const t = extractText(ev); if (t) emit({ lane, kind: "assistant", text: t }); }
          else if (ev?.type === "tool_call") emit({ lane, kind: "tool", tool: ev.tool ?? ev.name ?? "tool", detail: ev.detail ?? "" });
        }
        const result = (await run.wait().catch(() => null)) as any;
        const text = String(result?.result ?? "").trim();
        const verdict = /VERDICT:\s*APPROVE/i.test(text) ? "approve" : (/VERDICT:\s*REQUEST/i.test(text) ? "changes" : "review");
        let commentUrl: string | null = null;
        if (text) {
          commentUrl = await postPrComment(prUrl, `**Sentinel · agent review of this PR**\n\n${text}\n\n_Posted automatically by the Sentinel reviewer agent (${MODEL}). A human still owns the merge._`).catch(() => null);
        }
        emit({ lane, kind: "review", verdict, text, prUrl, commentUrl, ...receiptOf(result, t0) });
        emit({ lane, kind: "done", status: "review-complete", noPr: true });
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

server.listen(PORT, () => {
  console.log(`\n  Sentinel cockpit → http://localhost:${PORT}   (live cloud run: ${process.env.CURSOR_API_KEY ? "enabled" : "set CURSOR_API_KEY to enable"})\n`);
});
