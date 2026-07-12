const mongoose = require("mongoose");

/**
 * SicBoBet — one persisted bet. Written to Mongo AT PLACEMENT inside the debit
 * transaction (never memory-only), so it is the financial source of truth for
 * settlement and reconnect. One row per (roundId, userId, betType): repeat bets on
 * the same zone accumulate into `amount` so the unique index also blocks the
 * duplicate-settlement race.
 */
const sicboBetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    roundId: { type: String, required: true, index: true },
    betType: { type: String, required: true },
    /** Original staked amount (sum of chips placed on this zone this round). */
    amount: { type: Number, required: true, min: 0 },
    /** Net odds multiplier captured at placement (audit). */
    odds: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["placed", "won", "lost", "refunded"],
      default: "placed",
      index: true,
    },
    payout: { type: Number, default: 0, min: 0 },
    /** Idempotency key for the win credit (roundId:userId:betType). */
    settlementKey: { type: String, index: true },
    settledAt: { type: Date },
  },
  { timestamps: true }
);

// One aggregated bet per (round, user, zone) — also the double-settlement guard.
sicboBetSchema.index({ roundId: 1, userId: 1, betType: 1 }, { unique: true });
sicboBetSchema.index({ roundId: 1, status: 1 });
sicboBetSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("SicBoBet", sicboBetSchema);
