import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFromVector, severityFromScore } from "../src/cvss.ts";

test("computes 9.8 for a fully-critical network vector", () => {
  assert.equal(scoreFromVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), 9.8);
});

test("computes a low score for a limited vector", () => {
  const s = scoreFromVector("CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N");
  assert.equal(s, 3.1);
});

test("handles scope-changed vectors", () => {
  const s = scoreFromVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H");
  assert.equal(s, 10);
});

test("maps scores to severity bands", () => {
  assert.equal(severityFromScore(9.8), "CRITICAL");
  assert.equal(severityFromScore(7.5), "HIGH");
  assert.equal(severityFromScore(5.5), "MEDIUM");
  assert.equal(severityFromScore(3.1), "LOW");
});

test("returns null for a malformed vector", () => {
  assert.equal(scoreFromVector("not-a-vector"), null);
});
