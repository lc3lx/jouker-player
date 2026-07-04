const mongoose = require("mongoose");
const { VIP_LEVELS } = require("../config/vipConfig");

/**
 * WeeklyCashback — one row per user per cashback week (Monday→Monday UTC).
 * Computed lazily on demand and by the Monday sweep; unique {userId, weekKey}
 * guarantees idempotent computation, `status` guards double claims.
 */
const vipWeeklyCashbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** UTC date string of the week's Monday (start), e.g. "2026-06-29". */
    weekKey: { type: String, required: true },
    weekStart: { type: Date, required: true },
    weekEnd: { type: Date, required: true },
    level: { type: String, enum: [...VIP_LEVELS, null], default: null },
    cashbackPercent: { type: Number, default: 0 },
    /** Total game losses inside the week (wins ignored). */
    weeklyLosses: { type: Number, default: 0, min: 0 },
    cashbackAmount: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["claimable", "claimed", "none"],
      default: "none",
      index: true,
    },
    claimedAt: { type: Date },
  },
  { timestamps: true }
);

vipWeeklyCashbackSchema.index({ userId: 1, weekKey: 1 }, { unique: true });
vipWeeklyCashbackSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("WeeklyCashback", vipWeeklyCashbackSchema);
