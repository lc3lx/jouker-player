const mongoose = require("mongoose");

const userTaskClaimSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    taskId: { type: String, required: true, index: true },
    period: {
      type: String,
      enum: ["daily", "weekly", "seasonal"],
      required: true,
      index: true,
    },
    periodKey: { type: String, required: true, index: true },
    chipsGranted: { type: Number, default: 0 },
    xpGranted: { type: Number, default: 0 },
    claimedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

userTaskClaimSchema.index({ userId: 1, taskId: 1, period: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model("UserTaskClaim", userTaskClaimSchema);
