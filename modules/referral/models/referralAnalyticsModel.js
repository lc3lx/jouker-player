const mongoose = require("mongoose");

const referralAnalyticsSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    totalInvited: { type: Number, default: 0, min: 0 },
    qualifiedInvitees: { type: Number, default: 0, min: 0 },
    activeInvitees: { type: Number, default: 0, min: 0 },
    averageLevel: { type: Number, default: 0 },
    averageRecharge: { type: Number, default: 0 },
    averageLifetimeValue: { type: Number, default: 0 },
    totalRewardsPaid: { type: Number, default: 0, min: 0 },
    conversionRate: { type: Number, default: 0 },
    firstInviteAt: { type: Date, default: null },
    lastInviteActivityAt: { type: Date, default: null },
    registrationDate: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReferralAnalytics", referralAnalyticsSchema);
