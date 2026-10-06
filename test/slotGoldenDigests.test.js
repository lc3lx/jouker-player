process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeDigests } = require("../tool/slotGoldenDigests");
const { digests: expected } = require("./fixtures/slotGoldenDigests.json");

// Every engine version a pinned bonus session can still reach must keep
// dealing exactly the same game. Regenerate the fixture only for an intended
// outcome change: node tool/slotGoldenDigests.js --write
for (const name of Object.keys(expected)) {
  test(`${name} outcomes are unchanged`, () => {
    assert.deepEqual(computeDigests([name])[name], expected[name]);
  });
}
