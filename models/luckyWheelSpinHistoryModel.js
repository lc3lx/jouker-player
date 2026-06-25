const mongoose = require("mongoose");

const luckyWheelSpinHistorySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reward: { type: Number, required: true, min: 0 },
    rewardTier: {
      type: String,
      enum: ["minimum", "next", "mid", "high", "rare", "jackpot"],
      required: true,
    },
    guaranteedMinimum: { type: Number, required: true, min: 0 },
    currentStreak: { type: Number, required: true, min: 1 },
    spunAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

luckyWheelSpinHistorySchema.index({ userId: 1, spunAt: -1 });

module.exports = mongoose.model("LuckyWheelSpinHistory", luckyWheelSpinHistorySchema);
