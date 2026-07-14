import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const template = readFileSync(new URL("../src/cockpit/template-fleet.html", import.meta.url), "utf8");

test("fleet cockpit surfaces process-level routing blocks", () => {
  assert.match(template, /routing blocked/);
  assert.match(template, /dispatch blocked/);
  assert.match(template, /investigation incomplete/);
  assert.match(template, /s\.incomplete/);
  assert.match(template, /global-log/);
  assert.match(template, /addGlobal\(message/);
});

test("fleet cockpit distinguishes advisory lanes from hard read-only controls", () => {
  assert.match(template, /advisory cloud agent/);
  assert.match(template, /no automatic PR/);
});
