const mongoose = require("mongoose");

/**
 * Per-item, per-day usage counters powering the economy analytics APIs.
 *
 * Wallet ledger rows only capture CHARGED events (interaction_purchase /
 * interaction_use), so free consumable sends would be invisible to analytics.
 * This collection records every send/receive/purchase plus revenue, keyed by
 * (itemKey, day), giving accurate most-sent / most-received / popularity and
 * daily/weekly/monthly rollups via cheap counter `$inc`s.
 */
const interactionUsageDailySchema = new mongoose.Schema(
  {
    /** InteractionItem.key */
    itemKey: { type: String, required: true, index: true },
    /** UTC day bucket, "YYYY-MM-DD". */
    day: { type: String, required: true, index: true },
    sends: { type: Number, default: 0 },
    receives: { type: Number, default: 0 },
    purchases: { type: Number, default: 0 },
    /** Coins spent on this item that day (purchases + per-use/pay-per-use sends). */
    revenue: { type: Number, default: 0 },
  },
  { timestamps: true }
);

interactionUsageDailySchema.index({ itemKey: 1, day: 1 }, { unique: true });

/** UTC "YYYY-MM-DD" for a timestamp. */
interactionUsageDailySchema.statics.dayKey = function dayKey(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
};

module.exports = mongoose.model("InteractionUsageDaily", interactionUsageDailySchema);
