const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");

const agentProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    roleType: {
      type: String,
      enum: ["agent", "promoter"],
      required: true,
    },
    referralCode: {
      type: String,
      unique: true,
      uppercase: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "suspended"],
      default: "pending",
      index: true,
    },
    salesCommissionPercent: {
      // نسبة عمولة الشحن المباشر الذي يقوم به الوكيل/المروج
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    referralCommissionPercent: {
      // نسبة عمولة شحن المحالّين (Downline) عندما يشحنون بأنفسهم
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    stats: {
      totalTopups: { type: Number, default: 0 },
      totalVolume: { type: Number, default: 0 },
      totalCommission: { type: Number, default: 0 },
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

agentProfileSchema.statics.generateReferralCode = function () {
  return uuidv4().slice(0, 8).replace(/-/g, "").toUpperCase();
};

module.exports = mongoose.model("AgentProfile", agentProfileSchema);
