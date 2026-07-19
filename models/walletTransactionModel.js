const mongoose = require("mongoose");

const walletTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "userId is required"],
      index: true,
    },
    type: {
      type: String,
      enum: [
        "bet",
        "win",
        "rake",
        "refund",
        "transfer_to_locked",
        "transfer_to_balance",
        "credit",
        "debit",
        "recharge",
        "deposit",
        "withdraw",
        "pending_deposit",
        "confirmed_deposit",
        "failed_deposit",
        "pending_withdraw",
        "completed_withdraw",
        "cosmetic_purchase",
        "interaction_purchase",
        "interaction_use",
        "game_buyin",
        "game_win",
        "game_loss",
        "settlement",
        "island_jackpot_entry",
        "island_jackpot_win",
        "agent_deposit_in",
        "agent_deposit_out",
        "admin_agent_credit",
        "admin_agent_debit",
        "referral_reward",
        "gift_sent",
        "gift_received",
        "cosmetic_gift",
        "vip_gift",
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
    lockedBalanceBefore: { type: Number, required: true },
    lockedBalanceAfter: { type: Number, required: true },
    tableId: { type: mongoose.Schema.ObjectId, ref: "Table", index: true },
    handId: { type: String, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: false }
);

walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ tableId: 1, handId: 1, createdAt: 1 });
walletTransactionSchema.index({ userId: 1, "meta.rewardId": 1 }, { sparse: true });

module.exports = mongoose.model("WalletTransaction", walletTransactionSchema);

