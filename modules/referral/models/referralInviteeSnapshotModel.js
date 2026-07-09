const mongoose = require("mongoose");

const referralInviteeSnapshotSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    inviteeId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    level: { type: Number, default: 1 },
    xp: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
    handsPlayed: { type: Number, default: 0 },
    spins: { type: Number, default: 0 },
    completedMatches: { type: Number, default: 0 },
    totalRecharge: { type: Number, default: 0 },
    activeDays: { type: Number, default: 0 },
    qualifiedTiers: [{ type: String }],
    lastActiveAt: { type: Date, default: Date.now },
    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

referralInviteeSnapshotSchema.index({ referrerId: 1, inviteeId: 1 }, { unique: true });

module.exports = mongoose.model("ReferralInviteeSnapshot", referralInviteeSnapshotSchema);
