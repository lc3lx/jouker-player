const mongoose = require("mongoose");
const { VIP_LEVELS } = require("../config/vipConfig");

/**
 * VIPSubscription — one document per user (authoritative membership state).
 * Status:
 *   active    — membership currently valid (expireDate in the future)
 *   cancelled — user cancelled auto-renew; stays usable until expireDate
 *   expired   — expireDate passed (kept for restore / history)
 */
const vipSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    currentLevel: {
      type: String,
      enum: VIP_LEVELS,
      required: true,
    },
    startDate: { type: Date, required: true },
    expireDate: { type: Date, required: true, index: true },
    autoRenew: { type: Boolean, default: true },
    purchaseProvider: {
      type: String,
      enum: ["google_play", "apple", "stripe", "admin", "restore"],
      default: "admin",
    },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired"],
      default: "active",
      index: true,
    },
    /** Provider subscription/receipt reference (idempotency + restore). */
    providerRef: { type: String, index: true },
  },
  { timestamps: true }
);

vipSubscriptionSchema.index({ status: 1, expireDate: 1 });

module.exports = mongoose.model("VIPSubscription", vipSubscriptionSchema);
