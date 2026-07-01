const mongoose = require("mongoose");

const gameInvitationSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    to: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    gameType: {
      type: String,
      enum: ["poker", "trix", "tarneeb41", "vip", "lobby", "tournament"],
      required: true,
    },
    table: { type: mongoose.Schema.ObjectId, ref: "Table" },
    tournament: { type: mongoose.Schema.ObjectId, ref: "Tournament" },
    tableNumber: { type: Number },
    displayName: { type: String, trim: true },
    joinPayload: { type: mongoose.Schema.Types.Mixed },
    status: {
      type: String,
      enum: ["pending", "accepted", "declined", "expired", "cancelled"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    respondedAt: Date,
  },
  { timestamps: true }
);

gameInvitationSchema.index({ to: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("GameInvitation", gameInvitationSchema);
