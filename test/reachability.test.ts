import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReachability } from "../src/reachability.ts";

const here = dirname(fileURLToPath(import.meta.url));
const miniapp = join(here, "fixtures", "miniapp");

test("a package imported from a reachable file is reachable", () => {
  const r = buildReachability(miniapp);
  const ev = r.forPackage("live-pkg");
  assert.equal(ev.reachable, true);
  assert.ok(ev.reachablePath && ev.reachablePath[0].endsWith("index.ts"));
  assert.ok(ev.importSites.some((f) => f.endsWith("used.ts")));
});

test("a package only imported from an orphaned file is unreachable", () => {
  const r = buildReachability(miniapp);
  const ev = r.forPackage("dead-pkg");
  assert.equal(ev.reachable, false);
  assert.ok(ev.importSites.some((f) => f.endsWith("orphan.ts"))); // present but off-path
});

test("resolves the entrypoint", () => {
  const r = buildReachability(miniapp);
  assert.ok(r.entry && r.entry.endsWith("index.ts"));
  assert.ok(r.scannedFiles >= 3);
});
