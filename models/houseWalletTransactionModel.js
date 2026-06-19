const mongoose = require("mongoose");

const houseWalletTransactionSchema = new mongoose.Schema(
  {
    houseKey: {
      type: String,
      required: true,
      default: "house-main",
      index: true,
    },
    type: {
      type: String,
      enum: [
        "house_credit",
        "house_debit",
        "house_settlement",
        "house_rake",
        "house_bot_buyin",
        "house_bot_payout",
      ],
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "amount must be >= 0"],
    },
    balanceBefore: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    lockedBalanceBefore: { type: Number, required: true, default: 0 },
    lockedBalanceAfter: { type: Number, required: true, default: 0 },
    tableId: { type: mongoose.Schema.ObjectId, ref: "Table", index: true },
    handId: { type: String, index: true },
    settlementId: { type: String, index: true },
    meta: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

houseWalletTransactionSchema.index({ houseKey: 1, createdAt: -1 });

module.exports = mongoose.model("HouseWalletTransaction", houseWalletTransactionSchema);
