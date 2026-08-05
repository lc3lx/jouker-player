const mongoose = require("mongoose");

/**
 * Durable follow-up work created inside the poker-hand financial transaction.
 * `handId + type` is the idempotency key: a recovery replay can enqueue the
 * request again, but can never create a second jackpot settlement task.
 */
const pokerPostSettlementJobSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["island_jackpot"],
      required: true,
      index: true,
    },
    handId: { type: String, required: true, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true },
    handHistory: { type: mongoose.Schema.ObjectId, ref: "HandHistory", required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0, min: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

pokerPostSettlementJobSchema.index({ type: 1, handId: 1 }, { unique: true });
pokerPostSettlementJobSchema.index({ status: 1, nextAttemptAt: 1 });
// Completed jobs are recoverability infrastructure, not the permanent audit
// record (HandHistory, IslandWinner and wallet ledger remain permanent).
pokerPostSettlementJobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("PokerPostSettlementJob", pokerPostSettlementJobSchema);
