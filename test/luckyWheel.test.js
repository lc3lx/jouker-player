const test = require("node:test");
const assert = require("node:assert/strict");

// Inline copies of pure functions for unit testing (keep in sync with service)
const STREAK_BASE_TOKENS = 5000;
const STREAK_MAX_GUARANTEE = 100000;
const TIER_MULTIPLIERS_LOW = [1, 1.5, 2, 3, 4, 5];
const TIER_MULTIPLIERS_MID = [1, 1.2, 1.5, 2, 3, 4];
const TIER_MULTIPLIERS_HIGH = [1, 1.25, 1.5, 2, 3, 5];

function guaranteedMinimumForStreak(streakDay) {
  const day = Math.max(1, Math.floor(streakDay || 1));
  return Math.min(day * STREAK_BASE_TOKENS, STREAK_MAX_GUARANTEE);
}

function tierMultipliersForStreak(streakDay) {
  if (streakDay >= 20) return TIER_MULTIPLIERS_HIGH;
  if (streakDay >= 10) return TIER_MULTIPLIERS_MID;
  return TIER_MULTIPLIERS_LOW;
}

function buildRewardTable(guaranteedMin, streakDay) {
  const multipliers = tierMultipliersForStreak(streakDay);
  return multipliers.map((m) => Math.round(guaranteedMin * m));
}

test("streak guaranteed minimum caps at 100k", () => {
  assert.equal(guaranteedMinimumForStreak(1), 5000);
  assert.equal(guaranteedMinimumForStreak(10), 50000);
  assert.equal(guaranteedMinimumForStreak(20), 100000);
  assert.equal(guaranteedMinimumForStreak(50), 100000);
});

test("reward tables match spec examples", () => {
  assert.deepEqual(buildRewardTable(5000, 1), [5000, 7500, 10000, 15000, 20000, 25000]);
  assert.deepEqual(buildRewardTable(50000, 10), [50000, 60000, 75000, 100000, 150000, 200000]);
  assert.deepEqual(buildRewardTable(100000, 20), [100000, 125000, 150000, 200000, 300000, 500000]);
});
