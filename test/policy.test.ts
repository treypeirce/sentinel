import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSensitive } from "../src/policy.ts";

test("flags the money-movement path as sensitive", () => {
  const rule = matchSensitive(["src/payments/tokenSigning.ts"]);
  assert.ok(rule);
  assert.equal(rule.name, "money-movement");
});

test("does not flag ordinary route code", () => {
  assert.equal(matchSensitive(["src/routes/orders.ts", "src/middleware/auth.ts"]), null);
});
