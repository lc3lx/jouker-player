"use strict";
const engine = require("./DiceEngine");

// Pure staging: entitlement and cumulative cap change only when money commits.
function stageSpinSession(previous, outcome, payout, bet) {
  payout = Math.round(payout);
  if (!previous) {
    const awarded = outcome.scatterCount >= 4 && !outcome.capped ? engine.FREE_SPINS_AWARD : 0;
    return { payout, capReached: !!outcome.capped, awarded, totalWon: awarded ? payout : 0,
      next: awarded ? { remaining: awarded, lockedBaseBet: bet, lockedDoubleChance: !!outcome.doubleChance,
        totalMultiplier: 0, roundCap: outcome.maxWin || engine.MAX_WIN_MULTIPLIER * bet, roundWon: payout,
        superBonus: false, economyVersion: 2 } : null };
  }
  const left = Math.max(0, Number(previous.roundCap || 0) - Number(previous.roundWon || 0));
  const credited = previous.roundCap > 0 ? Math.min(payout, left) : payout;
  const capReached = !!outcome.capped || (previous.roundCap > 0 && credited >= left);
  const awarded = !capReached && outcome.scatterCount >= engine.RETRIGGER_MIN_SCATTER ? engine.RETRIGGER_AWARD : 0;
  const remaining = capReached ? 0 : Math.min(50, previous.remaining + awarded) - 1;
  const totalWon = Math.round(Number(previous.roundWon || 0) + credited);
  return { payout: Math.round(credited), capReached, awarded, totalWon,
    next: remaining > 0 ? { ...previous, remaining, roundWon: totalWon, totalMultiplier: outcome.multipliers.freeSpinTotal } : null };
}
// A database unique key survives Redis outages, process restarts and concurrent nodes.
async function recordSpinReceipt(userId, tableId, nonce, session) {
  if (!session) throw new Error("MONGO_TRANSACTIONS_REQUIRED_FOR_SLOTS");
  const requestId = require("crypto").createHash("sha256")
    .update(JSON.stringify([String(tableId), BigInt(nonce).toString()])).digest("hex");
  await require("../../models/slotOperationModel").create([{
    userId: String(userId), game: "zeus-spin", requestId, fingerprint: requestId,
    response: { ok: false, code: "invalid_nonce" },
  }], { session });
}
module.exports = { stageSpinSession, recordSpinReceipt };
