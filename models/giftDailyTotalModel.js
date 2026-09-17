const mongoose = require("mongoose");

/**
 * How many coins one player has gifted another on a given day.
 *
 * The cap is per sender→recipient pair, so the counter is keyed by the pair and
 * the day rather than by the sender alone. Keeping it in its own document (and
 * not deriving it from the ledger at read time) is what makes the check
 * race-safe: the reservation is a single conditional `$inc`, so two gifts sent
 * at the same moment cannot both read an under-limit total and both go through.
 *
 * Rows expire on their own — nothing reads a bucket once its day has passed.
 */
const giftDailyTotalSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    recipient: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: { type: String, required: true },
    coins: { type: Number, required: true, default: 0, min: 0 },
    /** TTL anchor — set a couple of days out so a bucket outlives its own day. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

giftDailyTotalSchema.index(
  { sender: 1, recipient: 1, day: 1 },
  { unique: true, name: "gift_pair_day_unique" }
);
giftDailyTotalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("GiftDailyTotal", giftDailyTotalSchema);
