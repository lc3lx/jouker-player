const mongoose = require("mongoose");

const playerAnalyticsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    gameType: { type: String, enum: ["poker", "trix", "tarneeb41"], default: "poker", index: true },
    period: { type: String, enum: ["all", "monthly"], default: "all", index: true },
    handsPlayed: { type: Number, default: 0 },
    handsWon: { type: Number, default: 0 },
    vpip: { type: Number, default: 0 },
    pfr: { type: Number, default: 0 },
    threeBet: { type: Number, default: 0 },
    foldToThreeBet: { type: Number, default: 0 },
    aggression: { type: Number, default: 0 },
    wtsd: { type: Number, default: 0 },
    totalProfit: { type: Number, default: 0 },
    totalInvested: { type: Number, default: 0 },
    avgPot: { type: Number, default: 0 },
    biggestPotWon: { type: Number, default: 0 },
    longestWinStreak: { type: Number, default: 0 },
    currentWinStreak: { type: Number, default: 0 },
    rawCounters: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

playerAnalyticsSchema.index({ user: 1, gameType: 1, period: 1 }, { unique: true });

module.exports = mongoose.model("PlayerAnalytics", playerAnalyticsSchema);
