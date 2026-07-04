
const mongoose = require("mongoose");

/**
 * VIPQuizAttempt — one attempt per user per UTC day. The unique
 * {userId, dayUtc} index enforces "cannot answer twice".
 */
const vipQuizAttemptSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    dayUtc: { type: String, required: true },
    questionId: {
      type: mongoose.Schema.ObjectId,
      ref: "VIPQuizQuestion",
      required: true,
    },
    answerIndex: { type: Number, required: true, min: 0 },
    correct: { type: Boolean, required: true },
    reward: { type: Number, default: 0, min: 0 },
    answeredAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

vipQuizAttemptSchema.index({ userId: 1, dayUtc: 1 }, { unique: true });

module.exports = mongoose.model("VIPQuizAttempt", vipQuizAttemptSchema);
