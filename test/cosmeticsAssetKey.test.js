const test = require("node:test");
const assert = require("node:assert/strict");

const SAFE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function assertSanitized(assetKey) {
  const k = String(assetKey || "").trim();
  if (k.length < 1 || k.length > 64) throw new Error("len");
  if (!SAFE.test(k)) throw new Error("pattern");
}

test("rejects path-like or empty asset keys", () => {
  assert.throws(() => assertSanitized(""), Error);
  assert.throws(() => assertSanitized("../x"), Error);
  assert.throws(() => assertSanitized("foo/bar"), Error);
});

test("accepts normal pack ids", () => {
  assertSanitized("default");
  assertSanitized("midnight_royal");
  assertSanitized("ruby");
});
