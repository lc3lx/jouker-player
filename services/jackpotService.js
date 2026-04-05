const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Jackpot = require("../models/jackpotModel");
const Wallet = require("../models/walletModel");

// Get jackpot status
exports.getStatus = asyncHandler(async (req, res) => {
  const j = await Jackpot.getSingleton();
  res.status(200).json({ data: j });
});

// Contribute to jackpot (protected)
exports.contribute = asyncHandler(async (req, res, next) => {
  const count = Math.max(1, parseInt(req.body.count || "1", 10));
  const j = await Jackpot.getSingleton();

  // Debit wallet
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) wallet = await Wallet.create({ user: req.user._id });

  const total = j.contributionPerHand * count;
  if (total > 0) {
    if (!wallet.hasSufficientBalance(total)) {
      return next(new ApiError("Insufficient wallet balance", 400));
    }
    await wallet.addTransaction(
      "debit",
      total,
      `Jackpot contribution x${count}`
    );
  }

  j.pot += total;
  await j.save();

  res.status(200).json({ status: "success", data: { pot: j.pot } });
});

// Settle jackpot win (admin/manager)
exports.settle = asyncHandler(async (req, res, next) => {
  const { userId, handType } = req.body;
  if (!userId || !handType) return next(new ApiError("userId and handType required", 400));

  const j = await Jackpot.getSingleton();
  const payouts = j.payouts || {};
  const factor =
    handType === "royalFlush"
      ? payouts.royalFlush
      : handType === "straightFlush"
      ? payouts.straightFlush
      : handType === "fullHouse"
      ? payouts.fullHouse
      : null;
  if (factor === null) return next(new ApiError("Invalid handType", 400));

  const amount = Math.floor(j.pot * factor);
  if (amount <= 0) return next(new ApiError("Nothing to settle", 400));

  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) wallet = await Wallet.create({ user: userId });
  await wallet.addTransaction("credit", amount, `Jackpot win (${handType})`);

  // Reduce pot and set last win
  j.pot = Math.max(0, j.pot - amount);
  j.lastWin = { user: userId, amount, handType, at: new Date() };
  await j.save();

  res.status(200).json({ status: "success", data: { paid: amount, pot: j.pot } });
});
