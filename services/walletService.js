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

// @desc    Get user wallet
// @route   GET /api/v1/wallet
// @access  Protected/User
exports.getUserWallet = asyncHandler(async (req, res, next) => {
  const wallet = await Wallet.findOne({ user: req.user._id })
    .populate("user", "name email")
    .sort({ "transactions.createdAt": -1 });

  if (!wallet) {
    return next(new ApiError("Wallet not found", 404));
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

  // Find the recharge code
  const rechargeCode = await RechargeCode.findOne({ code: code.toUpperCase() });

  if (!rechargeCode) {
    return next(new ApiError("Invalid recharge code", 400));
  }

  // Check if code has already been used
  if (rechargeCode.isUsed) {
    return next(
      new ApiError(
        "This recharge code has already been used and cannot be used again",
        400
      )
    );
  }

  // Check if code is expired
  if (rechargeCode.isExpired()) {
    return next(new ApiError("This recharge code has expired", 400));
  }

  // Get user wallet
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) {
    // Create wallet if it doesn't exist
    wallet = await Wallet.create({ user: req.user._id });
    await User.findByIdAndUpdate(req.user._id, { wallet: wallet._id });
  }

  // Double-check that code hasn't been used before attempting to use it
  if (rechargeCode.isUsed) {
    return next(
      new ApiError(
        "This recharge code has already been used and cannot be used again",
        400
      )
    );
  }

  // Use the recharge code
  await rechargeCode.useCode(req.user._id);

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
