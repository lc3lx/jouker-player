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
    /** UTC calendar day of last activeDays increment (YYYY-MM-DD). */
    lastActiveDayUtc: { type: String, default: null },
    qualifiedTiers: [{ type: String }],
    lastActiveAt: { type: Date, default: Date.now },
    registeredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

referralInviteeSnapshotSchema.index({ referrerId: 1, inviteeId: 1 }, { unique: true });
referralInviteeSnapshotSchema.index({ inviteeId: 1 });
referralInviteeSnapshotSchema.index({ referrerId: 1, lastActiveAt: -1 });

module.exports = mongoose.model("ReferralInviteeSnapshot", referralInviteeSnapshotSchema);
