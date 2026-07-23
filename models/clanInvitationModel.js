const mongoose = require("mongoose");

/** An invitation from a clan member to a user. One pending row per (clan,invitedUser). */
const clanInvitationSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    invitedUser: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    invitedBy: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    message: { type: String, maxlength: 200, trim: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired", "cancelled"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clanInvitationSchema.index({ invitedUser: 1, status: 1, createdAt: -1 });
clanInvitationSchema.index(
  { clan: 1, invitedUser: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

module.exports = mongoose.model("ClanInvitation", clanInvitationSchema);
