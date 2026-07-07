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
        emit({ kind: "done", status: result?.status ?? "complete", branch, prUrl: pr });
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
              emit({ lane, kind: "done", status: result?.status ?? "complete", prUrl: result?.git?.branches?.[0]?.prUrl });
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

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, () => {
  console.log(`\n  Sentinel cockpit → http://localhost:${PORT}   (live cloud run: ${process.env.CURSOR_API_KEY ? "enabled" : "set CURSOR_API_KEY to enable"})\n`);
});
