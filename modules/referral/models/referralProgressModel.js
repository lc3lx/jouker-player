const mongoose = require("mongoose");

const referralProgressSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    qualifiedCounts: {
      tier_5: { type: Number, default: 0, min: 0 },
      tier_15: { type: Number, default: 0, min: 0 },
      tier_25: { type: Number, default: 0, min: 0 },
      tier_30: { type: Number, default: 0, min: 0 },
    },
    milestoneStatus: {
      type: Map,
      of: {
        type: String,
        enum: ["open", "ready", "claimed", "pending_review"],
      },
      default: {},
    },
    suspended: { type: Boolean, default: false, index: true },
    whitelisted: { type: Boolean, default: false },
    blacklisted: { type: Boolean, default: false },
    lastUpdatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReferralProgress", referralProgressSchema);
