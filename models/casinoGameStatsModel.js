const mongoose = require("mongoose");

/** Aggregated bet/payout for RTP steering (scalable: one doc per game key). */
const casinoGameStatsSchema = new mongoose.Schema(
  {
    gameKey: { type: String, required: true, unique: true, index: true },
    totalBet: { type: Number, default: 0 },
    totalPayout: { type: Number, default: 0 },
    spinCount: { type: Number, default: 0 },
    bigWinCount: { type: Number, default: 0 },
    megaWinCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CasinoGameStats", casinoGameStatsSchema);
