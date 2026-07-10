const mongoose = require("mongoose");

const referralAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      index: true,
      enum: [
        "invitation_linked",
        "qualification_achieved",
        "milestone_ready",
        "reward_claim_requested",
        "reward_approved",
        "reward_rejected",
        "reward_completed",
        "fraud_detected",
        "fraud_cleared",
        "admin_suspend",
        "admin_whitelist",
        "admin_blacklist",
        "admin_recalculate",
      ],
    },
    referrerId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    inviteeId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      index: true,
      default: null,
    },
    tierId: { type: String, default: null, index: true },
    rewardId: {
      type: mongoose.Schema.ObjectId,
      ref: "ReferralRewardQueue",
      default: null,
    },
    actorId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      default: null,
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

referralAuditLogSchema.index({ referrerId: 1, createdAt: -1 });
referralAuditLogSchema.index({ inviteeId: 1, createdAt: -1 });
referralAuditLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("ReferralAuditLog", referralAuditLogSchema);
