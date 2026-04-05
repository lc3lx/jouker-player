const mongoose = require("mongoose");

const gameSessionSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.ObjectId,
      ref: "Player",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
      index: true,
    },
    won: { type: Boolean, default: false },
    tournament: { type: mongoose.Schema.ObjectId, ref: "Tournament" },
    score: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    durationSec: { type: Number, default: 0 },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

gameSessionSchema.index({ player: 1, status: 1 });

module.exports = mongoose.model("GameSession", gameSessionSchema);
