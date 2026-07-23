const mongoose = require("mongoose");

/**
 * Append-only audit ledger for a clan's treasury. Every mutation to
 * Clan.treasury.balance writes one row here (inside the same DB transaction as
 * the wallet ledger movement), so the treasury is fully reconcilable.
 */
const clanTreasuryTransactionSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    type: {
      type: String,
      enum: [
        "donation",
        "tournament_escrow",
        "tournament_payout",
        "event",
        "admin_adjust",
        "refund",
      ],
      required: true,
      index: true,
    },
    /** "in" credits the treasury, "out" debits it. */
    direction: { type: String, enum: ["in", "out"], required: true },
    amount: { type: Number, required: true, min: 0 },
    user: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    balanceAfter: { type: Number, required: true, min: 0 },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

clanTreasuryTransactionSchema.index({ clan: 1, createdAt: -1 });

module.exports = mongoose.model("ClanTreasuryTransaction", clanTreasuryTransactionSchema);
