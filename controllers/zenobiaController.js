const asyncHandler = require("express-async-handler");
const zenobiaService = require("../games/zenobia/zenobiaService");

/** Resolve player id from JWT only (set by authService.protect). */
function requireUserId(req, res, next) {
  const userId = req.user?._id || req.user?.id;
  if (!userId) {
    return res.status(401).json({
      status: "fail",
      message: "Unauthorized",
    });
  }
  req.zenobiaUserId = String(userId);
  return next();
}

exports.spin = asyncHandler(async (req, res) => {
  const { betAmount } = req.body;
  const data = await zenobiaService.executeSpin(req.zenobiaUserId, betAmount);
  res.status(200).json({ status: "success", data });
});

exports.buyBonus = asyncHandler(async (req, res) => {
  const { currentBet, superBonus } = req.body;
  const data = await zenobiaService.executeBuyBonus(
    req.zenobiaUserId,
    currentBet,
    { superBonus: superBonus === true || superBonus === "true" },
  );
  res.status(200).json({ status: "success", data });
});

exports.session = asyncHandler(async (req, res) => {
  const data = await zenobiaService.getActiveSession(req.zenobiaUserId);
  res.status(200).json({ status: "success", data });
});

exports.jackpotRecover = asyncHandler(async (req, res) => {
  const userId = req.zenobiaUserId;
  const { roundId } = req.query;
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  const zenobiaJackpot = require("../games/zenobia/zenobiaJackpot");
  const data = await zenobiaJackpot.recoverRound(roundId, userId);
  if (!data) {
    return res
      .status(404)
      .json({ status: "fail", message: "Jackpot round not found" });
  }
  res.status(200).json({ status: "success", data });
});

exports.jackpotReveal = asyncHandler(async (req, res) => {
  const userId = req.zenobiaUserId;
  const { roundId, cardIndex } = req.body || {};
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  const zenobiaJackpot = require("../games/zenobia/zenobiaJackpot");
  try {
    const data = await zenobiaJackpot.revealCard(roundId, userId, cardIndex);
    res.status(200).json({ status: "success", data });
  } catch (err) {
    res.status(400).json({
      status: "fail",
      message: err?.message || "Reveal failed",
    });
  }
});

exports.jackpotSettle = asyncHandler(async (req, res) => {
  const userId = req.zenobiaUserId;
  const { roundId } = req.body || {};
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  const zenobiaJackpot = require("../games/zenobia/zenobiaJackpot");
  const data = await zenobiaJackpot.settleRound(roundId, userId);
  res.status(200).json({ status: "success", data });
});

exports.requireUserId = requireUserId;
