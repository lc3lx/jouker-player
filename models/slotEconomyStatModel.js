const mongoose = require("mongoose");

/**
 * Hourly economy totals per slot game and economy profile — the source of the
 * admin dashboard's realized RTP, house profit and drift alerts. Written after
 * each committed spin/purchase/jackpot (games/utils/slotEconomyStats.js);
 * money truth stays in the wallet ledger (tool/slotStatsReconcile.js can
 * rebuild the money columns from it).
 *
 * Origins: "paid" = paid spins, "natural" = free spins from a natural trigger,
 * "buy" / "super" = free spins of a purchased round. Jackpot payouts carry the
 * origin of the spin that triggered them.
 */
const slotEconomyStatSchema = new mongoose.Schema(
  {
    game: { type: String, required: true },
    profileId: { type: String, required: true }, // "legacy-v<N>" before profiles go live
    hour: { type: Date, required: true },

    paidSpins: { type: Number, default: 0 },
    paidBet: { type: Number, default: 0 },
    paidBetSq: { type: Number, default: 0 },
    paidWin: { type: Number, default: 0 },
    paidHits: { type: Number, default: 0 },
    plaqueSpins: { type: Number, default: 0 },
    naturalTriggers: { type: Number, default: 0 },
    jackpotTriggers: { type: Number, default: 0 },

    naturalSpins: { type: Number, default: 0 },
    naturalWin: { type: Number, default: 0 },

    buys: { type: Number, default: 0 },
    buySpend: { type: Number, default: 0 },
    buySpins: { type: Number, default: 0 },
    buyWin: { type: Number, default: 0 },
    superBuys: { type: Number, default: 0 },
    superSpend: { type: Number, default: 0 },
    superSpins: { type: Number, default: 0 },
    superWin: { type: Number, default: 0 },

    jackpotPaidBase: { type: Number, default: 0 },
    jackpotPaidBuy: { type: Number, default: 0 },
    jackpotPaidSuper: { type: Number, default: 0 },
    jackpotRounds: { type: Number, default: 0 },

    cappedRounds: { type: Number, default: 0 },
    maxWinX: { type: Number, default: 0 },
  },
  { collection: "slot_economy_stats" },
);

slotEconomyStatSchema.index({ game: 1, profileId: 1, hour: 1 }, { unique: true });
slotEconomyStatSchema.index({ hour: 1 });

module.exports = mongoose.model("SlotEconomyStat", slotEconomyStatSchema);
