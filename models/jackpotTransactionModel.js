const mongoose = require("mongoose");

const jackpotTransactionSchema = new mongoose.Schema(
  {
    txnId: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    direction: {
      type: String,
      enum: ["debit_entry", "credit_payout"],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    walletTxnRef: { type: String, default: "" },
    islandHistoryId: { type: mongoose.Schema.ObjectId, ref: "IslandHistory" },
    idempotencyKey: { type: String, default: "", index: true },
    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
    },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

jackpotTransactionSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
jackpotTransactionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("JackpotTransaction", jackpotTransactionSchema);
