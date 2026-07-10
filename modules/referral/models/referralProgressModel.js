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
      type: Map,
      of: Number,
      default: () => new Map(),
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
    suspendedReason: { type: String, default: null },
    whitelisted: { type: Boolean, default: false },
    blacklisted: { type: Boolean, default: false },
    lastUpdatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReferralProgress", referralProgressSchema);
