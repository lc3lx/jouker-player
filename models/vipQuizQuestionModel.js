const mongoose = require("mongoose");
const { VIP_QUIZ_DEFAULT_REWARD } = require("../config/vipConfig");

/** VIPQuizQuestion — admin-managed pool for the daily Gold/Platinum quiz. */
const vipQuizQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true, maxlength: 500 },
    options: {
      type: [{ type: String, trim: true, maxlength: 200 }],
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length >= 2 && arr.length <= 6,
        message: "Quiz question needs 2–6 options",
      },
      required: true,
    },
    correctIndex: { type: Number, required: true, min: 0 },
    /** Chips granted on a correct answer (configurable per question). */
    reward: { type: Number, default: VIP_QUIZ_DEFAULT_REWARD, min: 0 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("VIPQuizQuestion", vipQuizQuestionSchema);
