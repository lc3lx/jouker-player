const mongoose = require("mongoose");

const paymentIntentSchema = new mongoose.Schema(
  {
    intentId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    flow: { type: String, enum: ["deposit", "withdraw"], required: true },
    amount: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true,
    },
    /** For withdraw: client must wait until this time before calling confirm */
    processAfter: { type: Date },
    failureReason: { type: String },
    /** simulated | stripe | crypto_usdt */
    provider: {
      type: String,
      enum: ["simulated", "stripe", "crypto_usdt"],
      default: "simulated",
    },
    /** Provider payment id (e.g. Stripe PaymentIntent id). */
    providerRef: { type: String, index: true },
    /** Returned to client for Stripe.js (do not log in production). */
    clientSecret: { type: String, select: false },
    providerMeta: { type: mongoose.Schema.Types.Mixed },
    /** Stripe webhook idempotency lock (same event may be redelivered). */
    webhookLockEvent: { type: String, index: true },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
  },
  { timestamps: false }
);

paymentIntentSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("PaymentIntent", paymentIntentSchema);
