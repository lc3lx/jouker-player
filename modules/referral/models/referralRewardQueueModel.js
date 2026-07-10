const mongoose = require("mongoose");

const referralRewardQueueSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    tierId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "processing", "approved", "rejected", "completed"],
      default: "pending",
      index: true,
    },
    rewardPayload: {
      chips: { type: Number, default: 0 },
      vipLevel: { type: String, default: null },
      vipDays: { type: Number, default: 0 },
    },
    fraudScoreAtClaim: { type: Number, default: 0 },
    autoApproved: { type: Boolean, default: false },
    reviewedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    completedAt: { type: Date, default: null },
    walletTxMeta: { type: mongoose.Schema.Types.Mixed, default: null },
    vipHistoryId: { type: String, default: null },
  },
  { timestamps: true }
);

referralRewardQueueSchema.index({ referrerId: 1, tierId: 1 }, { unique: true });
referralRewardQueueSchema.index({ status: 1, createdAt: -1 });
referralRewardQueueSchema.index({ referrerId: 1, status: 1 });

module.exports = mongoose.model("ReferralRewardQueue", referralRewardQueueSchema);
