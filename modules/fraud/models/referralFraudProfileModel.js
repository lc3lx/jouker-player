const mongoose = require("mongoose");

const referralFraudProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    score: { type: Number, default: 0, min: 0, max: 100 },
    band: { type: String, default: "safe" },
    reasons: [{ type: String }],
    signals: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: [
      {
        score: Number,
        reasons: [String],
        at: { type: Date, default: Date.now },
      },
    ],
    suspended: { type: Boolean, default: false },
    whitelisted: { type: Boolean, default: false },
    blacklisted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ReferralFraudProfile", referralFraudProfileSchema);
