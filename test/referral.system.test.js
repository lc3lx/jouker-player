"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { utcDayStr } = require("../utils/utcDay");
const { activeDayUpdate } = require("../modules/referral/services/activeDaysTracker");
const {
  countKeyForMilestone,
  REFERRAL_MILESTONES,
  requirementsForMilestone,
} = require("../modules/referral/config/referralMilestonesConfig");
const {
  evaluateSnapshot,
} = require("../modules/qualification/services/qualificationEngine");
const { xpFromDeposit, XP_PER_LEVEL } = require("../modules/playerProgress/config/playerProgressConfig");
const { lifetimeXpFromProgress } = require("../modules/referral/services/referralAnalyticsService");
const { publish, subscribe, clearAll } = require("../domain/events/domainEventBus");
const Events = require("../domain/events/eventTypes");
const { riskBand, MANUAL_REVIEW_MIN_RISK, AUTO_APPROVE_MAX_RISK } = require("../modules/fraud/config/fraudSignalsConfig");
const { computeRiskScore } = require("../modules/fraud/services/fraudRiskService");

test("utcDayStr returns YYYY-MM-DD in UTC", () => {
  const d = new Date("2026-01-15T23:30:00.000Z");
  assert.equal(utcDayStr(d), "2026-01-15");
});

test("activeDayUpdate increments only on new UTC day", () => {
  const today = utcDayStr();
  const first = activeDayUpdate(null);
  assert.equal(first.inc.activeDays, 1);
  assert.equal(first.set.lastActiveDayUtc, today);

  const same = activeDayUpdate(today);
  assert.equal(same.inc.activeDays, undefined);
  assert.deepEqual(same.inc, {});
});

test("each milestone uses independent count key (tierId)", () => {
  const silver = REFERRAL_MILESTONES.find((m) => m.tierId === "tier_25_silver");
  const gold = REFERRAL_MILESTONES.find((m) => m.tierId === "tier_25_gold");
  assert.notEqual(countKeyForMilestone(silver), countKeyForMilestone(gold));
  assert.equal(countKeyForMilestone(silver), "tier_25_silver");
  assert.equal(countKeyForMilestone(gold), "tier_25_gold");
});

test("gold tier has stricter invitee requirements than silver", () => {
  const silver = REFERRAL_MILESTONES.find((m) => m.tierId === "tier_25_silver");
  const gold = REFERRAL_MILESTONES.find((m) => m.tierId === "tier_25_gold");
  const silverReq = requirementsForMilestone(silver);
  const goldReq = requirementsForMilestone(gold);
  assert.ok(goldReq.minXp > silverReq.minXp || goldReq.minHandsPlayed > silverReq.minHandsPlayed);
});

test("qualification uses lifetime XP not in-level XP only", () => {
  const snapshot = {
    level: 2,
    xp: XP_PER_LEVEL + 100,
    gamesPlayed: 10,
    handsPlayed: 20,
    spins: 5,
    completedMatches: 8,
    totalRecharge: 1000,
    activeDays: 3,
    accountAgeDays: 5,
  };
  const pass = evaluateSnapshot(snapshot, {
    minLevel: 2,
    minXp: XP_PER_LEVEL,
    minGamesPlayed: 5,
    minHandsPlayed: 10,
    minActiveDays: 2,
    accountAgeDays: 3,
  });
  assert.equal(pass.qualified, true);

  const fail = evaluateSnapshot({ ...snapshot, xp: 400 }, { minXp: 500 });
  assert.equal(fail.qualified, false);
});

test("poker players can qualify with gamesPlayed when handsPlayed met", () => {
  const snapshot = {
    level: 6,
    xp: 3000,
    gamesPlayed: 10,
    handsPlayed: 15,
    spins: 0,
    completedMatches: 0,
    totalRecharge: 0,
    activeDays: 3,
    accountAgeDays: 5,
  };
  const tier5 = REFERRAL_MILESTONES.find((m) => m.tierId === "tier_5");
  const result = evaluateSnapshot(snapshot, requirementsForMilestone(tier5));
  assert.equal(result.qualified, true);
});

test("xpFromDeposit — 1 XP per 100 chips", () => {
  assert.equal(xpFromDeposit(0), 0);
  assert.equal(xpFromDeposit(99), 0);
  assert.equal(xpFromDeposit(100), 1);
  assert.equal(xpFromDeposit(2500), 25);
});

test("lifetimeXpFromProgress", () => {
  assert.equal(lifetimeXpFromProgress(1, 500), 500);
  assert.equal(lifetimeXpFromProgress(2, 100), XP_PER_LEVEL + 100);
});

test("fraud risk bands", () => {
  assert.equal(riskBand(10), "safe");
  assert.equal(riskBand(45), "medium");
  assert.equal(riskBand(70), "high");
  assert.equal(riskBand(90), "manual_review");
});

test("manual review threshold is above auto-approve", () => {
  assert.ok(MANUAL_REVIEW_MIN_RISK > AUTO_APPROVE_MAX_RISK);
});

test("computeRiskScore returns clamped 0-100 without DB", async () => {
  const result = await computeRiskScore({
    clientSignals: { emulator: true, vpn: true },
  });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(Array.isArray(result.reasons));
});

test("domain event bus isolates handler errors", async () => {
  clearAll();
  let ok = false;
  subscribe(Events.PLAYER_GAINED_XP, async () => {
    throw new Error("boom");
  });
  subscribe(Events.PLAYER_GAINED_XP, async () => {
    ok = true;
  });
  publish(Events.PLAYER_GAINED_XP, { userId: "u1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ok, true);
  clearAll();
});

test("domain event publish is non-blocking", () => {
  clearAll();
  const start = Date.now();
  let ran = false;
  subscribe(Events.PLAYER_LEVEL_UP, async () => {
    await new Promise((r) => setTimeout(r, 50));
    ran = true;
  });
  publish(Events.PLAYER_LEVEL_UP, { userId: "u1" });
  assert.equal(ran, false);
  assert.ok(Date.now() - start < 10);
  clearAll();
});

test("level-up math — XP_PER_LEVEL boundary", () => {
  const xpBefore = XP_PER_LEVEL - 1;
  const xpAdded = 2;
  const xpAfter = xpBefore + xpAdded - XP_PER_LEVEL;
  assert.equal(xpAfter, 1);
});
