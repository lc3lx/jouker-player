"use strict";
process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const operation = require("../games/utils/slotOperation");
const wallet = require("../games/poseidon/poseidonWalletAdapter");

test("unresponsive post-commit work cannot block the result, retry or next spin", { timeout: 2000 }, async () => {
  const manager = { getBonusSession: () => null, replaceBonusSession() {} };
  const input = { game: "liveness", userId: "liveness-user", wallet, manager,
    requestId: "liveness_001", input: { bet: 10 } };
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  let calls = 0;
  try {
    const first = await operation.run(input, async () => {
      calls++;
      operation.afterCommit(() => stalled);
      return { balance: 123 };
    });
    assert.deepEqual(first, { balance: 123 });
    assert.deepEqual(await operation.run(input, async () => { calls++; }), first);
    const next = await operation.run({ ...input, requestId: "liveness_002" }, async () => ({ balance: 113 }));
    assert.equal(next.balance, 113);
    assert.equal(calls, 1);
  } finally { release(); }
});
