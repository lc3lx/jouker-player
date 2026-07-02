const test = require("node:test");
const assert = require("node:assert/strict");

test("pokerTableGameBridge exposes getTableGameDebugSnapshot after tableGame loads", () => {
  const bridge = require("../sockets/pokerTableGameBridge");
  require("../sockets/tableGame");
  assert.equal(typeof bridge.getTableGameDebugSnapshot, "function");
  const snap = bridge.getTableGameDebugSnapshot("nonexistent-table-id");
  assert.equal(snap, null);
});
