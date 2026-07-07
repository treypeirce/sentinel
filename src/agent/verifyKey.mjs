/**
 * Cheap credential check. Confirms CURSOR_API_KEY is present and, if the SDK
 * exposes a lightweight model catalog call, that the key authenticates —
 * without spending an agent run. Run via:
 *   RunWithCredentials(skillName="Cursor Agent Key",
 *     command="node /agent/workspace/sentinel/src/agent/verifyKey.mjs")
 */
const key = process.env.CURSOR_API_KEY;
if (!key) {
  console.error("✗ CURSOR_API_KEY not set. Enter it on the 'Cursor Agent Key' skill card.");
  process.exit(2);
}
console.log(`✓ key present (length ${key.length}, prefix ${key.slice(0, 6)}…)`);

try {
  const sdk = await import("@cursor/sdk");
  const listFn = sdk.Cursor?.models?.list ?? sdk.models?.list;
  if (typeof listFn === "function") {
    const models = await listFn.call(sdk.Cursor?.models ?? sdk.models);
    const ids = Array.isArray(models) ? models.map((m) => m.id ?? m.name ?? m).slice(0, 8) : models;
    console.log("✓ authenticated with Cursor. models:", JSON.stringify(ids));
  } else {
    console.log("• SDK imported OK; no cheap catalog call available — auth will be confirmed by the first agent run.");
  }
} catch (e) {
  console.error("✗ auth/import check failed:", e?.message ?? e);
  process.exit(1);
}
