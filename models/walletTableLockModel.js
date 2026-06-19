const mongoose = require("mongoose");

const walletTableLockSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    table: {
      type: mongoose.Schema.ObjectId,
      ref: "Table",
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);

walletTableLockSchema.index({ user: 1, table: 1 }, { unique: true });

module.exports = mongoose.model("WalletTableLock", walletTableLockSchema);
