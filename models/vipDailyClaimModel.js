const mongoose = require("mongoose");
const { VIP_LEVELS } = require("../config/vipConfig");

/**
 * DailyVIPClaim — one row per user per UTC day. The unique {userId, dayUtc}
 * index is the duplicate-claim guard (separate from the normal daily bonus).
 */
const vipDailyClaimSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dayUtc: { type: String, required: true },
    level: { type: String, enum: VIP_LEVELS, required: true },
    amount: { type: Number, required: true, min: 0 },
    claimedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

vipDailyClaimSchema.index({ userId: 1, dayUtc: 1 }, { unique: true });
vipDailyClaimSchema.index({ userId: 1, claimedAt: -1 });

module.exports = mongoose.model("DailyVIPClaim", vipDailyClaimSchema);
