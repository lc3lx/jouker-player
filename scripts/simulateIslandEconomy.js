/* eslint-disable no-console */
/**
 * Island Jackpot economy simulation — 1 year projection.
 *
 * Run: node scripts/simulateIslandEconomy.js
 */
"use strict";

const { calculatePayoutShares, computePoolFlags } = require("../utils/islandJackpotLogic");

const DAYS = 365;
const ENTRY_FEE = 50_000;
const MIN_TRIGGER = 100_000_000;
const PAYOUT_PCT = { royalFlush: 0.8, straightFlush: 0.3, fourOfAKind: 0.2 };

/** Approximate daily qualifying-hand rate per active member (very conservative). */
const HAND_RATES = {
  royalFlush: 1 / 500_000,
  straightFlush: 1 / 80_000,
  fourOfAKind: 1 / 8_000,
};

function simulateYear(playerCount, { participationRate = 0.15, handsPerDay = 80 } = {}) {
  const rng = mulberry32(playerCount);
  let pool = 0;
  let totalIn = 0;
  let totalOut = 0;
  let winEvents = 0;
  let peakPool = 0;
  const members = Math.floor(playerCount * participationRate);

  for (let day = 0; day < DAYS; day += 1) {
    const dailyJoins = Math.floor(members * 0.02);
    const joinCoins = dailyJoins * ENTRY_FEE;
    pool += joinCoins;
    totalIn += joinCoins;
    if (pool > peakPool) peakPool = pool;

    const flags = computePoolFlags({ poolBalance: pool, minTriggerAmount: MIN_TRIGGER });
    if (!flags.armed) continue;

    const handsToday = members * handsPerDay;
    for (const [handType, rate] of Object.entries(HAND_RATES)) {
      const expected = handsToday * rate;
      const events = poisson(rng, expected);
      for (let e = 0; e < events; e += 1) {
        const plan = calculatePayoutShares(pool, PAYOUT_PCT[handType], 1);
        if (!plan) continue;
        pool -= plan.actualTotal;
        totalOut += plan.actualTotal;
        winEvents += 1;
      }
    }
  }

  return {
    playerCount,
    members,
    totalIn,
    totalOut,
    netToJackpot: totalIn - totalOut,
    winEvents,
    avgWinsPerDay: Number((winEvents / DAYS).toFixed(3)),
    peakPool,
    endPool: pool,
    retentionRate: totalIn > 0 ? Number(((totalIn - totalOut) / totalIn).toFixed(4)) : 0,
  };
}

function mulberry32(a) {
  return function rand() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poisson(rng, lambda) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > L);
  return k - 1;
}

function recommendPercentages(results) {
  const avgRetention =
    results.reduce((s, r) => s + r.retentionRate, 0) / results.length;
  if (avgRetention < 0.55) {
    return {
      suggestion: "Lower payout percentages slightly to protect house economy",
      royalFlush: 0.65,
      straightFlush: 0.25,
      fourOfAKind: 0.15,
      minTriggerAmount: 120_000_000,
      entryFee: 50_000,
    };
  }
  if (avgRetention > 0.85) {
    return {
      suggestion: "Jackpot may grow too slowly — consider slightly higher payouts or lower min trigger",
      royalFlush: 0.85,
      straightFlush: 0.35,
      fourOfAKind: 0.22,
      minTriggerAmount: 80_000_000,
      entryFee: 50_000,
    };
  }
  return {
    suggestion: "Current ratios are balanced for long-term retention",
    royalFlush: 0.8,
    straightFlush: 0.3,
    fourOfAKind: 0.2,
    minTriggerAmount: MIN_TRIGGER,
    entryFee: ENTRY_FEE,
  };
}

const scales = [10_000, 50_000, 100_000];
const results = scales.map((n) => simulateYear(n));

console.log("=== Island Jackpot Economy Simulation (365 days) ===\n");
for (const r of results) {
  console.log(`Players: ${r.playerCount.toLocaleString()}`);
  console.log(`  Active members (~15%): ${r.members.toLocaleString()}`);
  console.log(`  Coins IN (entry fees):  ${r.totalIn.toLocaleString()}`);
  console.log(`  Coins OUT (payouts):    ${r.totalOut.toLocaleString()}`);
  console.log(`  Net retained in pool:   ${r.netToJackpot.toLocaleString()}`);
  console.log(`  Win events / year:      ${r.winEvents}`);
  console.log(`  Avg wins / day:         ${r.avgWinsPerDay}`);
  console.log(`  Peak pool:              ${r.peakPool.toLocaleString()}`);
  console.log(`  End pool:               ${r.endPool.toLocaleString()}`);
  console.log(`  Retention rate:         ${(r.retentionRate * 100).toFixed(1)}%`);
  console.log("");
}

const rec = recommendPercentages(results);
console.log("=== Recommendation ===");
console.log(JSON.stringify(rec, null, 2));
