const test = require("node:test");
const assert = require("node:assert/strict");

const {
  guaranteedMinimumForStreak,
  buildRewardTable,
  ensureAccrualDay,
  syncAccruedSpins,
  MAX_SPINS_PER_DAY,
  SPIN_COOLDOWN_MS,
  utcDayStr,
  secondsUntilUtcMidnight,
} = require("../services/luckyWheelService");

test("streak guaranteed minimum caps at 100k", () => {
  assert.equal(guaranteedMinimumForStreak(1), 5000);
  assert.equal(guaranteedMinimumForStreak(10), 50000);
  assert.equal(guaranteedMinimumForStreak(20), 100000);
  assert.equal(guaranteedMinimumForStreak(50), 100000);
});

test("reward tables match improved multipliers", () => {
  assert.deepEqual(buildRewardTable(5000, 1), [5000, 7500, 10000, 15000, 20000, 30000]);
  assert.deepEqual(buildRewardTable(50000, 10), [50000, 62500, 80000, 110000, 175000, 250000]);
  assert.deepEqual(buildRewardTable(100000, 20), [100000, 130000, 170000, 250000, 400000, 700000]);
});

test("new UTC day expires unused spins and grants first spin", () => {
  const now = new Date("2026-06-18T10:00:00.000Z");
  const wheel = {
    accrualDayUtc: "2026-06-17",
    availableSpins: 3,
    spinsGrantedToday: 4,
    lastAccrualAt: new Date("2026-06-17T20:00:00.000Z"),
    nextSpinAt: null,
  };

  const rolled = ensureAccrualDay(wheel, now);
  assert.equal(rolled, true);
  assert.equal(wheel.accrualDayUtc, "2026-06-18");
  assert.equal(wheel.availableSpins, 1);
  assert.equal(wheel.spinsGrantedToday, 1);
});

test("accrues one spin every 4 hours up to daily cap", () => {
  const start = new Date("2026-06-18T00:00:00.000Z");
  const wheel = {
    accrualDayUtc: utcDayStr(start),
    availableSpins: 1,
    spinsGrantedToday: 1,
    lastAccrualAt: start,
    nextSpinAt: new Date(start.getTime() + SPIN_COOLDOWN_MS),
  };

  const after8h = new Date(start.getTime() + 8 * 60 * 60 * 1000);
  syncAccruedSpins(wheel, after8h);
  assert.equal(wheel.spinsGrantedToday, 3);
  assert.equal(wheel.availableSpins, 3);
});

test("does not exceed max spins per day", () => {
  const start = new Date("2026-06-18T00:00:00.000Z");
  const wheel = {
    accrualDayUtc: utcDayStr(start),
    availableSpins: 1,
    spinsGrantedToday: 1,
    lastAccrualAt: start,
    nextSpinAt: new Date(start.getTime() + SPIN_COOLDOWN_MS),
  };

  const after24h = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1000);
  syncAccruedSpins(wheel, after24h);
  assert.equal(wheel.spinsGrantedToday, MAX_SPINS_PER_DAY);
  assert.ok(wheel.availableSpins <= MAX_SPINS_PER_DAY);
});

test("seconds until midnight is positive within day", () => {
  const noon = new Date("2026-06-18T12:00:00.000Z");
  const secs = secondsUntilUtcMidnight(noon);
  assert.equal(secs, 12 * 60 * 60);
});
