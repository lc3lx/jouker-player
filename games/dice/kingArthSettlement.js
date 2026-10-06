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
        superBonus: false, economyVersion: outcome.economyVersion || engine.ECONOMY_VERSION,
        profileId: outcome.profileId || null, origin: "natural", costPaid: 0 } : null };
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
/**
 * Settle one engine outcome: apply the plaque/bank multiplier, the per-spin
 * cap, then the cumulative round cap and entitlement via stageSpinSession.
 * Shared by the dice_spin handler and the economy simulator. Mutates
 * `outcome` exactly as the handler always did (totalWin, capped, multipliers,
 * winType) so the emitted result is unchanged.
 */
function settleSpin(outcome, previous, bet, stake) {
  const isFreeSpin = previous != null;
  const carried = isFreeSpin ? Number(previous.totalMultiplier || 0) : 0;
  const freshPlaques = Math.max(0, Number(outcome.multipliers.collected) || 0);
  const resolved = engine.resolvePayoutMultiplier({
    baseWin: outcome.baseWin,
    plaqueSum: freshPlaques,
    carried,
    isFreeSpin,
    bankCap: isFreeSpin
      ? (previous.superBonus ? engine.SUPER_BONUS_BANK_CAP : engine.BONUS_BANK_CAP)
      : Infinity,
  });
  // A bought/free-spin bank never multiplies a win that has no new plaque.
  const applied = freshPlaques > 0 ? resolved.applied : 1;
  const multiplied = Math.round(outcome.baseWin * applied * 100) / 100;
  outcome.totalWin = Math.min(multiplied, outcome.maxWin);
  outcome.capped = multiplied > outcome.maxWin;
  outcome.multipliers.applied = applied;
  outcome.multipliers.freeSpinTotal = resolved.nextCarried;
  outcome.winType = engine.classifyWinType(outcome.totalWin, stake);
  return stageSpinSession(previous, outcome, outcome.totalWin, bet);
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
module.exports = { settleSpin, stageSpinSession, recordSpinReceipt };
