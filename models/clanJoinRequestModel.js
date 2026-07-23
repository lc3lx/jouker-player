const mongoose = require("mongoose");

/** A player's request to join a `request`-type clan. One pending row per (clan,user). */
const clanJoinRequestSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, maxlength: 200, trim: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "cancelled"],
      default: "pending",
      index: true,
    },
    decidedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clanJoinRequestSchema.index({ clan: 1, status: 1, createdAt: -1 });
clanJoinRequestSchema.index({ user: 1, status: 1 });
// Only one OPEN request per (clan,user); resolved rows don't collide.
clanJoinRequestSchema.index(
  { clan: 1, user: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);

module.exports = mongoose.model("ClanJoinRequest", clanJoinRequestSchema);
