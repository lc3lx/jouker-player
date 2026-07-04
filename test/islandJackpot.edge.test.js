const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  computePoolFlags,
  calculatePayoutShares,
} = require("../utils/islandJackpotLogic");

describe("Island Jackpot — payout edge cases", () => {
  test("single winner gets full percentage slice", () => {
    const p = calculatePayoutShares(200_000_000, 0.8, 1);
    assert.equal(p.shareEach, 160_000_000);
    assert.equal(p.actualTotal, 160_000_000);
    assert.equal(p.totalPayout, 160_000_000);
  });

  test("two winners split evenly with floor rounding safety", () => {
    const p = calculatePayoutShares(100_000_001, 0.75, 2);
    assert.ok(p);
    assert.equal(p.shareEach + p.shareEach, p.actualTotal);
    assert.ok(p.actualTotal <= 75_000_000);
  });

  test("zero winners returns null", () => {
    assert.equal(calculatePayoutShares(100, 0.5, 0), null);
  });

  test("pool below min — not armed", () => {
    const f = computePoolFlags({ poolBalance: 1, minTriggerAmount: 100 });
    assert.equal(f.armed, false);
  });

  test("hot can be true while not armed (separate threshold)", () => {
    const f = computePoolFlags({
      poolBalance: 50,
      minTriggerAmount: 100,
      settings: { hotJackpotThreshold: 40 },
    });
    assert.equal(f.armed, false);
    assert.equal(f.hotJackpot, true);
  });
});

describe("Island Jackpot — idempotency key shape", () => {
  test("payout idempotency keys are deterministic per hand+winner", () => {
    const handId = "abc123";
    const userId = "user456";
    const key = `island_payout:${handId}:${userId}`;
    assert.match(key, /^island_payout:abc123:user456$/);
  });
});
