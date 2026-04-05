const mongoose = require("mongoose");

/** Idempotent webhook processing — never double-apply ledger from same provider event. */
const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    intentId: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
