/**
 * Cockpit server. Serves the built cockpit and exposes the run stream over SSE.
 *
 *   npm run cockpit           # serves http://localhost:4317
 *
 * /api/queue   → the triage queue (queue.json)
 * /api/stream  → Server-Sent Events of the remediation run. Today this replays
 *                the recorded run (mock-run.json); the live path swaps in the
 *                normalized Cursor SDK stream from the agent runner.
 *
 * The cockpit HTML is self-contained (it embeds the data), so it also works
 * opened directly as a file — the server is for a nicer local demo and the
 * future live stream.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const PORT = Number(process.env.PORT ?? 4317);

function send(res: any, code: number, type: string, body: string) {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/" || url.startsWith("/cockpit")) {
    const p = join(ROOT, "public", "cockpit.html");
    if (!existsSync(p)) return send(res, 500, "text/plain", "Run `npm run cockpit:build` first.");
    return send(res, 200, "text/html", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/api/queue")) {
    const p = join(ROOT, "queue.json");
    if (!existsSync(p)) return send(res, 404, "application/json", "{}");
    return send(res, 200, "application/json", readFileSync(p, "utf8"));
  }

  if (url.startsWith("/api/stream")) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const run = JSON.parse(readFileSync(join(here, "mock-run.json"), "utf8"));
    const events: any[] = run.events;
    let i = 0;
    const tick = () => {
      if (i >= events.length) {
        res.write("event: end\ndata: {}\n\n");
        return res.end();
      }
      const e = events[i++];
      res.write(`data: ${JSON.stringify(e)}\n\n`);
      setTimeout(tick, e.delay ?? 650);
    };
    tick();
    return;
  }

  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, () => {
  console.log(`\n  Sentinel cockpit → http://localhost:${PORT}\n`);
});
