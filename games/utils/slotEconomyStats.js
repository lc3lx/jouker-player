"use strict";

/**
 * Hourly economy telemetry for Poseidon / Zeus / Zenobia.
 *
 * Called from slotOperation.afterCommit (and the Zeus handler's post-commit
 * jobs), so a rolled-back spin is never counted and the stats never hold the
 * money transaction open on a hot shared document. Without a Mongo connection
 * (tests, local tools) the same totals accumulate in memory.
 */

const HOUR_MS = 60 * 60 * 1000;
const memory = new Map(); // `${game}|${profileId}|${hour}` → totals

function hourOf(now = Date.now()) {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS);
}

function profileKey(profileId, economyVersion) {
  return profileId || `legacy-v${economyVersion || 0}`;
}

function apply(game, profileId, inc, max = {}, now = Date.now()) {
  const hour = hourOf(now);
  const mongoose = require("mongoose");
  if (mongoose.connection?.readyState === 1) {
    const Model = require("../../models/slotEconomyStatModel");
    const update = { $inc: inc };
    if (Object.keys(max).length) update.$max = max;
    return Model.updateOne({ game, profileId, hour }, update, { upsert: true }).catch((err) => {
      require("../../utils/logger").warn("slot_economy_stat_failed", { game, reason: err?.message });
    });
  }
  const key = `${game}|${profileId}|${hour.toISOString()}`;
  const row = memory.get(key) || { game, profileId, hour };
  for (const [k, v] of Object.entries(inc)) row[k] = (row[k] || 0) + v;
  for (const [k, v] of Object.entries(max)) row[k] = Math.max(row[k] || 0, v);
  memory.set(key, row);
  return Promise.resolve();
}

/** A settled paid spin. Amounts in coins; winX in bet multiples. */
function recordPaidSpin({ game, profileId, economyVersion, bet, win, winX, plaque, naturalTrigger, jackpotTrigger }) {
  return apply(game, profileKey(profileId, economyVersion), {
    paidSpins: 1,
    paidBet: bet,
    paidBetSq: bet * bet,
    paidWin: win,
    paidHits: win > 0 ? 1 : 0,
    plaqueSpins: plaque ? 1 : 0,
    naturalTriggers: naturalTrigger ? 1 : 0,
    jackpotTriggers: jackpotTrigger ? 1 : 0,
  }, { maxWinX: winX || 0 });
}

/** A settled free spin of a natural, bought or super round. */
function recordFreeSpin({ game, profileId, economyVersion, origin, win, winX, roundCapped }) {
  const field = origin === "super" ? "super" : origin === "buy" ? "buy" : "natural";
  return apply(game, profileKey(profileId, economyVersion), {
    [`${field}Spins`]: 1,
    [`${field}Win`]: win,
    cappedRounds: roundCapped ? 1 : 0,
  }, { maxWinX: winX || 0 });
}

function recordBuy({ game, profileId, economyVersion, superBonus, cost }) {
  return apply(game, profileKey(profileId, economyVersion), superBonus
    ? { superBuys: 1, superSpend: cost }
    : { buys: 1, buySpend: cost });
}

/** A settled jackpot round; origin is the spin that triggered it. */
function recordJackpotPaid({ game, profileId, economyVersion, origin, amount }) {
  const field = origin === "super" ? "jackpotPaidSuper" : origin === "buy" ? "jackpotPaidBuy" : "jackpotPaidBase";
  return apply(game, profileKey(profileId, economyVersion), { [field]: amount, jackpotRounds: 1 });
}

function _memoryRows() {
  return [...memory.values()];
}

function _clearForTests() {
  memory.clear();
}

module.exports = {
  hourOf,
  profileKey,
  recordPaidSpin,
  recordFreeSpin,
  recordBuy,
  recordJackpotPaid,
  _memoryRows,
  _clearForTests,
};
