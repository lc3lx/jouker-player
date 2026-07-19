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
    // --- agent deposit system (country agents crediting users via chat) ---
    deposit: {
      enabled: { type: Boolean, default: false, index: true },
      displayName: { type: String, default: "", trim: true, maxlength: 80 },
      countries: [{ type: String, uppercase: true, trim: true }],
      paymentMethods: [{ type: String, trim: true, maxlength: 60 }],
      workingHours: { type: String, default: "", trim: true, maxlength: 120 },
      rating: { type: Number, default: 5, min: 0, max: 5 },
      // Optional contact handles surfaced on the player profile popup.
      whatsapp: { type: String, default: "", trim: true, maxlength: 60 },
      telegram: { type: String, default: "", trim: true, maxlength: 60 },
      stats: {
        totalDeposits: { type: Number, default: 0 },
        totalVolume: { type: Number, default: 0 },
      },
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

agentProfileSchema.statics.generateReferralCode = function () {
  return uuidv4().slice(0, 8).replace(/-/g, "").toUpperCase();
};

module.exports = mongoose.model("AgentProfile", agentProfileSchema);
