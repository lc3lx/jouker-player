const mongoose = require("mongoose");

/**
 * Per-user, per-game statistics — the data-driven store behind the profile's
 * "deep game statistics" section. `metrics` is a free-form Map so a game can
 * record ANY counter/gauge (handsPlayed, showdowns, allIns, biggestPot, vpip,
 * pfr, contractsWon, …) with NO schema change. New games register their metrics
 * simply by calling gameStatsService.record() — the profile surfaces whatever
 * exists automatically.
 */
const playerGameStatsSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    /** Game key: poker | trix | tarneeb41 | <future>. */
    game: { type: String, required: true, index: true },
    /** metricKey → numeric value (counters via $inc, gauges via $set). */
    metrics: { type: Map, of: Number, default: () => new Map() },
  },
  { timestamps: true }
);

playerGameStatsSchema.index({ user: 1, game: 1 }, { unique: true });

module.exports = mongoose.model("PlayerGameStats", playerGameStatsSchema);
