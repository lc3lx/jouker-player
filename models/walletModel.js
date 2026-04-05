const mongoose = require("mongoose");
const WalletTransaction = require("./walletTransactionModel");

const walletSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "Wallet must belong to a user"],
      unique: true,
    },
    balance: {
      type: Number,
      default: 0,
      min: [0, "Wallet balance cannot be negative"],
    },
    lockedBalance: {
      type: Number,
      default: 0,
      min: [0, "Wallet locked balance cannot be negative"],
    },
    currency: {
      type: String,
      default: "USD",
    },
    transactions: [
      {
        type: {
          type: String,
          enum: ["credit", "debit", "refund", "recharge"],
          required: true,
        },
        amount: {
          type: Number,
          required: true,
        },
        description: {
          type: String,
          required: true,
        },
        orderId: {
          type: mongoose.Schema.ObjectId,
          ref: "Order",
        },
        rechargeCode: {
          type: mongoose.Schema.ObjectId,
          ref: "RechargeCode",
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Create wallet for user automatically
walletSchema.statics.createWalletForUser = async function (userId) {
  const wallet = await this.create({ user: userId });
  return wallet;
};

// Add transaction to wallet
walletSchema.methods.addTransaction = async function (
  type,
  amount,
  description,
  orderId = null,
  rechargeCode = null
) {
  const amt = Number(amount || 0);
  const beforeBalance = Number(this.balance || 0);
  const beforeLocked = Number(this.lockedBalance || 0);

  this.transactions.push({
    type,
    amount: amt,
    description,
    orderId,
    rechargeCode,
  });

  if (type === "credit" || type === "recharge") {
    this.balance += amt;
  } else if (type === "debit") {
    this.balance -= amt;
  } else if (type === "refund") {
    this.balance += amt;
  }

  await this.save();

  // Ledger record for backward-compatible paths still using addTransaction.
  await WalletTransaction.create({
    userId: this.user,
    type,
    amount: Math.floor(Math.abs(amt)),
    balanceBefore: Math.floor(beforeBalance),
    balanceAfter: Math.floor(this.balance || 0),
    lockedBalanceBefore: Math.floor(beforeLocked),
    lockedBalanceAfter: Math.floor(this.lockedBalance || 0),
    meta: {
      source: "wallet.addTransaction",
      description,
      orderId: orderId || null,
      rechargeCode: rechargeCode || null,
    },
  });
  return this;
};

// Check if user has sufficient balance
walletSchema.methods.hasSufficientBalance = function (amount) {
  return this.balance >= amount;
};

walletSchema.methods.hasSufficientAvailable = function (amount) {
  return this.balance >= amount;
};

module.exports = mongoose.model("Wallet", walletSchema);
