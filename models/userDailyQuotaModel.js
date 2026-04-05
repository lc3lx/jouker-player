const mongoose = require("mongoose");

/** UTC day bucket per user for deposit/withdraw/bonus/join-leave counters. */
const userDailyQuotaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    dayUtc: { type: String, required: true, index: true },
    depositTotal: { type: Number, default: 0 },
    withdrawTotal: { type: Number, default: 0 },
    bonusClaims: { type: Number, default: 0 },
    joinLeaveEvents: { type: Number, default: 0 },
  },
  { timestamps: false }
);

userDailyQuotaSchema.index({ userId: 1, dayUtc: 1 }, { unique: true });

module.exports = mongoose.model("UserDailyQuota", userDailyQuotaSchema);
