const mongoose = require("mongoose");

const playerXpHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    source: { type: String, required: true, index: true },
    sourceId: { type: String, default: "" },
    xpBefore: { type: Number, required: true, min: 0 },
    xpAdded: { type: Number, required: true, min: 0 },
    xpAfter: { type: Number, required: true, min: 0 },
    levelBefore: { type: Number, required: true, min: 1 },
    levelAfter: { type: Number, required: true, min: 1 },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

playerXpHistorySchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("PlayerXpHistory", playerXpHistorySchema);
