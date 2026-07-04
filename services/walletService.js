const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const User = require("../models/userModel");
const crypto = require("crypto");
const {
  withMongoTransaction,
  ledgerDeposit,
  ledgerWithdraw,
  appendBalancesUnchanged,
} = require("./walletLedgerService");
const RechargeCode = require("../models/rechargeCodeModel");
const AgentProfile = require("../models/agentProfileModel");
const SystemSettings = require("../models/systemSettingsModel");
const { getPublicCurrencySummary } = require("./currencySettingsService");
const { getOrCreateWallet } = require("./walletLedgerService");

const TX_LABELS = {
  win: "فوز في طاولة",
  bet: "خسارة في طاولة",
  rake: "عمولة الطاولة",
  deposit: "إيداع",
  confirmed_deposit: "شحن الرصيد",
  recharge: "شحن بكود",
  withdraw: "سحب",
  completed_withdraw: "سحب",
  pending_deposit: "إيداع قيد المعالجة",
  pending_withdraw: "سحب قيد المعالجة",
  failed_deposit: "فشل إيداع",
  cosmetic_purchase: "شراء من المتجر",
  credit: "إضافة رصيد",
  debit: "خصم",
  refund: "استرداد",
  transfer_to_locked: "حجز للطاولة",
  transfer_to_balance: "إرجاع من الطاولة",
  game_buyin: "دخول لعبة",
  game_win: "فوز في لعبة",
  game_loss: "خسارة في لعبة",
  settlement: "تسوية لعبة",
};

const CREDIT_TYPES = new Set([
  "win",
  "game_win",
  "deposit",
  "confirmed_deposit",
  "recharge",
  "credit",
  "refund",
  "transfer_to_balance",
]);

function txLabel(type, meta = {}) {
  if (meta?.source === "daily_bonus") return "مكافأة يومية";
  if (meta?.source === "task_reward") return "مكافأة مهمة";
  return TX_LABELS[type] || type;
}

function isCreditTx(type) {
  return CREDIT_TYPES.has(type);
}

function relativeAgeLabel(date, now = new Date()) {
  const ms = now.getTime() - new Date(date).getTime();
  if (ms < 0) return "الآن";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return mins === 1 ? "منذ دقيقة" : `منذ ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "منذ ساعة" : `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "أمس";
  if (days < 7) return `منذ ${days} أيام`;
  return new Date(date).toLocaleDateString("ar-SA");
}

function formatTxRow(tx, now = new Date()) {
  const amount = Math.floor(Number(tx.amount) || 0);
  const credit = isCreditTx(tx.type);
  return {
    id: String(tx._id),
    type: tx.type,
    label: txLabel(tx.type, tx.meta),
    subtitle: relativeAgeLabel(tx.createdAt, now),
    amount,
    amountDisplay: `${credit ? "+" : "-"}${amount.toLocaleString("en-US")}`,
    isCredit: credit,
    createdAt: tx.createdAt,
    meta: tx.meta || {},
  };
}

// @desc    Get user wallet
// @route   GET /api/v1/wallet
// @access  Protected/User
exports.getUserWallet = asyncHandler(async (req, res, next) => {
  let wallet = await Wallet.findOne({ user: req.user._id }).populate("user", "name email");
  if (!wallet) {
    wallet = await Wallet.create({ user: req.user._id });
    await User.findByIdAndUpdate(req.user._id, { wallet: wallet._id });
    wallet = await Wallet.findById(wallet._id).populate("user", "name email");
  }

  res.status(200).json({
    status: "success",
    data: wallet,
  });
});

// @desc    Create wallet for user (called automatically)
// @route   POST /api/v1/wallet
// @access  Protected/User
exports.createUserWallet = asyncHandler(async (req, res, next) => {
  // Check if user already has a wallet
  const existingWallet = await Wallet.findOne({ user: req.user._id });
  if (existingWallet) {
    return next(new ApiError("User already has a wallet", 400));
  }

  const wallet = await Wallet.create({ user: req.user._id });

  // Update user with wallet reference
  await User.findByIdAndUpdate(req.user._id, { wallet: wallet._id });

  res.status(201).json({
    status: "success",
    data: wallet,
  });
});

// @desc    Recharge wallet using code
// @route   POST /api/v1/wallet/recharge
// @access  Protected/User
exports.rechargeWallet = asyncHandler(async (req, res, next) => {
  const { code } = req.body;

  if (!code) {
    return next(new ApiError("Recharge code is required", 400));
  }

  // Atomic claim: mark isUsed=true only if it is currently false (prevents TOCTOU race).
  // A concurrent duplicate request will see modifiedCount=0 and be rejected below.
  const claimed = await RechargeCode.findOneAndUpdate(
    { code: code.toUpperCase(), isUsed: false },
    { $set: { isUsed: true, usedBy: req.user._id, usedAt: new Date() } },
    { new: false } // return pre-update doc so we can read amount / expiry
  );

  if (!claimed) {
    // Either the code doesn't exist, was already used, or a concurrent request
    // just claimed it — all three cases are treated as "invalid or already used".
    const existing = await RechargeCode.findOne({ code: code.toUpperCase() }).lean();
    if (!existing) {
      return next(new ApiError("Invalid recharge code", 400));
    }
    return next(
      new ApiError(
        "This recharge code has already been used and cannot be used again",
        400
      )
    );
  }

  // claimed is the pre-update document; check expiry after we hold the claim.
  if (typeof claimed.isExpired === "function" && claimed.isExpired()) {
    // Roll back the atomic claim so the code can still be invalidated/reissued by admin.
    await RechargeCode.findByIdAndUpdate(claimed._id, {
      $set: { isUsed: false, usedBy: null, usedAt: null },
    });
    return next(new ApiError("This recharge code has expired", 400));
  }

  const rechargeCode = claimed; // alias for readability below

  // Get or create user wallet
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) {
    wallet = await Wallet.create({ user: req.user._id });
    await User.findByIdAndUpdate(req.user._id, { wallet: wallet._id });
  }

  // Credit wallet (the atomic claim above ensures this runs exactly once).

  // Add transaction to wallet
  await wallet.addTransaction(
    "recharge",
    rechargeCode.amount,
    `Wallet recharge using code: ${rechargeCode.code}`,
    null,
    rechargeCode._id
  );

  // Referral commission to referrer (promoter/agent) if applicable
  try {
    const user = await User.findById(req.user._id).select("referredBy");
    if (user && user.referredBy) {
      const profile = await AgentProfile.findOne({ user: user.referredBy, status: "approved" });
      if (profile) {
        const defaults = await SystemSettings.getDefaults();
        const percent = (profile.referralCommissionPercent != null ? profile.referralCommissionPercent : defaults.defaultReferralCommissionPercent) || 0;
        const commission = Math.floor(rechargeCode.amount * percent);
        if (commission > 0) {
          let refWallet = await Wallet.findOne({ user: user.referredBy });
          if (!refWallet) refWallet = await Wallet.create({ user: user.referredBy });
          await refWallet.addTransaction("credit", commission, `Referral commission from ${req.user.email || req.user._id}`);
          profile.stats.totalCommission += commission;
          await profile.save();
        }
      }
    }
  } catch (e) {
    // do not block recharge on referral errors
  }

  res.status(200).json({
    status: "success",
    message: `Wallet recharged successfully with ${rechargeCode.amount} USD`,
    data: {
      wallet,
      rechargedAmount: rechargeCode.amount,
    },
  });
});

// @desc    Get wallet ledger transaction history (immutable collection)
// @route   GET /api/v1/wallet/transactions
// @access  Protected/User
exports.getWalletTransactions = asyncHandler(async (req, res, next) => {
  const page = req.query.page * 1 || 1;
  const limit = Math.min(100, req.query.limit * 1 || 20);
  const skip = (page - 1) * limit;

  const userId = req.user._id;
  const [transactions, totalTransactions] = await Promise.all([
    WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    WalletTransaction.countDocuments({ userId }),
  ]);

  res.status(200).json({
    status: "success",
    results: transactions.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(totalTransactions / limit) || 1,
      next: page * limit < totalTransactions ? page + 1 : null,
    },
    data: transactions,
  });
});

function parseSimulatedAmount(body) {
  const raw = body?.amount;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000_000) {
    return null;
  }
  return n;
}

// @desc    One-shot simulated deposit (pending + confirm in one atomic txn — compat shortcut)
// @route   POST /api/v1/wallet/deposit
// @access  Protected/User
exports.simulatedDeposit = asyncHandler(async (req, res, next) => {
  const amount = parseSimulatedAmount(req.body);
  if (amount == null) {
    return next(new ApiError("Invalid amount", 400));
  }
  const userId = req.user._id;
  const intentId = `legacy_dep_${crypto.randomBytes(8).toString("hex")}`;
  try {
    await withMongoTransaction(async (session) => {
      await appendBalancesUnchanged({
        session,
        userId,
        type: "pending_deposit",
        amount,
        meta: { intentId, source: "api_simulated_deposit_shortcut" },
      });
      await ledgerDeposit({
        session,
        userId,
        amount,
        meta: { intentId, source: "api_simulated_deposit_shortcut" },
        ledgerType: "confirmed_deposit",
      });
    });
  } catch (e) {
    if (String(e.message) === "INVALID_AMOUNT") {
      return next(new ApiError("Invalid amount", 400));
    }
    throw e;
  }
  const wallet = await Wallet.findOne({ user: userId });
  res.status(200).json({
    status: "success",
    data: {
      balance: wallet.balance,
      lockedBalance: wallet.lockedBalance || 0,
      currency: wallet.currency,
    },
  });
});

// @desc    One-shot simulated withdraw (pending + completed in one atomic txn — no delay)
// @route   POST /api/v1/wallet/withdraw
// @access  Protected/User
exports.simulatedWithdraw = asyncHandler(async (req, res, next) => {
  const amount = parseSimulatedAmount(req.body);
  if (amount == null) {
    return next(new ApiError("Invalid amount", 400));
  }
  const userId = req.user._id;
  const intentId = `legacy_wd_${crypto.randomBytes(8).toString("hex")}`;
  try {
    await withMongoTransaction(async (session) => {
      await appendBalancesUnchanged({
        session,
        userId,
        type: "pending_withdraw",
        amount,
        meta: { intentId, source: "api_simulated_withdraw_shortcut" },
      });
      await ledgerWithdraw({
        session,
        userId,
        amount,
        meta: { intentId, source: "api_simulated_withdraw_shortcut" },
        ledgerType: "completed_withdraw",
      });
    });
  } catch (e) {
    if (String(e.message) === "INSUFFICIENT_BALANCE") {
      return next(new ApiError("Insufficient balance", 400));
    }
    if (String(e.message) === "INVALID_AMOUNT") {
      return next(new ApiError("Invalid amount", 400));
    }
    throw e;
  }
  const wallet = await Wallet.findOne({ user: userId });
  res.status(200).json({
    status: "success",
    data: {
      balance: wallet.balance,
      lockedBalance: wallet.lockedBalance || 0,
      currency: wallet.currency,
    },
  });
});

// @desc    Wallet screen summary — balance, packages, formatted history
// @route   GET /api/v1/wallet/summary
// @access  Protected/User
exports.getWalletSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const wallet = await getOrCreateWallet(userId);
  const limit = Math.min(50, parseInt(req.query.limit || "30", 10));

  const [txs, totalTx] = await Promise.all([
    WalletTransaction.find({ userId }).sort({ createdAt: -1 }).limit(limit).lean(),
    WalletTransaction.countDocuments({ userId }),
  ]);

  const now = new Date();
  const currency = await getPublicCurrencySummary();
  const balance = Math.floor(wallet.balance || 0);
  const locked = Math.floor(wallet.lockedBalance || 0);

  res.status(200).json({
    status: "success",
    data: {
      balance,
      lockedBalance: locked,
      availableBalance: balance,
      currency: currency.currencyCode,
      currencyName: currency.currencyName,
      packages: currency.packages,
      transactions: txs.map((t) => formatTxRow(t, now)),
      pagination: {
        total: totalTx,
        limit,
        hasMore: totalTx > limit,
      },
    },
  });
});

// @desc    Check wallet balance
// @route   GET /api/v1/wallet/balance
// @access  Protected/User
exports.checkWalletBalance = asyncHandler(async (req, res, next) => {
  const wallet = await Wallet.findOne({ user: req.user._id });

  if (!wallet) {
    return next(new ApiError("Wallet not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: {
      balance: wallet.balance,
      currency: wallet.currency,
    },
  });
});

// Admin functions

// @desc    Get all wallets (Admin only)
// @route   GET /api/v1/wallet/admin/all
// @access  Protected/Admin
exports.getAllWallets = asyncHandler(async (req, res, next) => {
  const page = req.query.page * 1 || 1;
  const limit = req.query.limit * 1 || 10;
  const skip = (page - 1) * limit;

  const wallets = await Wallet.find()
    .populate("user", "name email phone")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

  const totalWallets = await Wallet.countDocuments();

  res.status(200).json({
    status: "success",
    results: wallets.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(totalWallets / limit),
      next: page * limit < totalWallets ? page + 1 : null,
    },
    data: wallets,
  });
});

// @desc    Get wallet by user ID (Admin only)
// @route   GET /api/v1/wallet/admin/:userId
// @access  Protected/Admin
exports.getWalletByUserId = asyncHandler(async (req, res, next) => {
  const wallet = await Wallet.findOne({ user: req.params.userId })
    .populate("user", "name email phone")
    .populate("transactions.rechargeCode")
    

  if (!wallet) {
    return next(new ApiError("Wallet not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: wallet,
  });
});

// @desc    Adjust wallet balance (Admin only)
// @route   PUT /api/v1/wallet/admin/:userId/adjust
// @access  Protected/Admin
exports.adjustWalletBalance = asyncHandler(async (req, res, next) => {
  const { amount, type, description } = req.body;

  if (!amount || !type || !description) {
    return next(
      new ApiError("Amount, type, and description are required", 400)
    );
  }

  if (!["credit", "debit"].includes(type)) {
    return next(new ApiError("Type must be either credit or debit", 400));
  }

  const wallet = await Wallet.findOne({ user: req.params.userId });

  if (!wallet) {
    return next(new ApiError("Wallet not found", 404));
  }

  // Add transaction
  await wallet.addTransaction(type, amount, `Admin adjustment: ${description}`);

  res.status(200).json({
    status: "success",
    message: `Wallet ${type}ed successfully with ${amount} USD`,
    data: wallet,
  });
});
