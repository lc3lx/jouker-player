const mongoose = require("mongoose");

/** An achievement earned by a clan. Unique (clan, defKey) → awarded at most once. */
const clanAchievementSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    defKey: { type: String, required: true, index: true },
    awardedAt: { type: Date, default: Date.now },
    /** Snapshot of the metric value at award time (for display / audit). */
    metaValue: { type: Number, default: null },
  },
  { timestamps: true }
);

clanAchievementSchema.index({ clan: 1, defKey: 1 }, { unique: true });

module.exports = mongoose.model("ClanAchievement", clanAchievementSchema);
