const mongoose = require("mongoose");

/**
 * Data-driven achievement definition. Adding a new clan achievement = inserting a
 * new document here (via admin) — no code changes. `criteria` is evaluated against
 * a clan's live stats by clanAchievementService.
 *
 * criteria shape: { metric: "<Clan.stats key>", op: "gte", threshold: <number> }
 * e.g. { metric: "tournamentWins", op: "gte", threshold: 100 }
 */
const clanAchievementDefSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    icon: { type: String, default: "trophy" },
    criteria: { type: mongoose.Schema.Types.Mixed, required: true },
    rewardCoins: { type: Number, default: 0, min: 0 },
    rewardXp: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClanAchievementDef", clanAchievementDefSchema);
