const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  computePoolFlags,
  calculatePayoutShares,
  isAnnouncementsEnabled,
  isEffectsEnabled,
} = require("../utils/islandJackpotLogic");

test("computePoolFlags — not armed below min trigger", () => {
  const f = computePoolFlags({ poolBalance: 50_000_000, minTriggerAmount: 100_000_000 });
  assert.equal(f.armed, false);
  assert.equal(f.hotJackpot, false);
});

test("computePoolFlags — armed and hot at threshold", () => {
  const f = computePoolFlags({ poolBalance: 100_000_000, minTriggerAmount: 100_000_000 });
  assert.equal(f.armed, true);
  assert.equal(f.hotJackpot, true);
});

test("computePoolFlags — separate hot threshold", () => {
  const f = computePoolFlags({
    poolBalance: 80_000_000,
    minTriggerAmount: 100_000_000,
    settings: { hotJackpotThreshold: 75_000_000 },
  });
  assert.equal(f.armed, false);
  assert.equal(f.hotJackpot, true);
});

test("calculatePayoutShares — splits among winners", () => {
  const p = calculatePayoutShares(100_000_000, 0.8, 2);
  assert.ok(p);
  assert.equal(p.shareEach, 40_000_000);
  assert.equal(p.actualTotal, 80_000_000);
});

test("calculatePayoutShares — rejects invalid percentage", () => {
  assert.equal(calculatePayoutShares(100, 0, 1), null);
  assert.equal(calculatePayoutShares(100, -1, 1), null);
});

test("settings toggles default enabled", () => {
  assert.equal(isEffectsEnabled({}), true);
  assert.equal(isAnnouncementsEnabled({}), true);
  assert.equal(isEffectsEnabled({ settings: { effectsEnabled: false } }), false);
});
