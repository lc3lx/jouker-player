const asyncHandler = require("express-async-handler");
const poseidonService = require("../games/poseidon/poseidonService");
const {
  executeJackpotSettle,
  recoverJackpot,
  executeJackpotReveal,
} = poseidonService;

function requireUserId(req, res, next) {
  const userId =
    req.body?.userId || req.query?.userId || req.user?._id || req.user?.id;
  if (!userId) {
    return res.status(400).json({
      status: "fail",
      message: "userId is required",
    });
  }
  req.poseidonUserId = String(userId);
  return next();
}

exports.spin = asyncHandler(async (req, res) => {
  const { betAmount } = req.body;
  const data = await poseidonService.executeSpin(req.poseidonUserId, betAmount);
  res.status(200).json({ status: "success", data });
});

exports.buyBonus = asyncHandler(async (req, res) => {
  const { currentBet, superBonus } = req.body;
  const data = await poseidonService.executeBuyBonus(
    req.poseidonUserId,
    currentBet,
    { superBonus: superBonus === true || superBonus === "true" },
  );
  res.status(200).json({ status: "success", data });
});

exports.session = asyncHandler(async (req, res) => {
  const data = await poseidonService.getActiveSession(req.poseidonUserId);
  res.status(200).json({ status: "success", data });
});

exports.jackpotSettle = asyncHandler(async (req, res) => {
  const { roundId } = req.body;
  const data = await poseidonService.executeJackpotSettle(req.poseidonUserId, roundId);
  res.status(200).json({ status: "success", data });
});

exports.jackpotRecover = asyncHandler(async (req, res) => {
  const { roundId } = req.query;
  const data = await poseidonService.recoverJackpot(req.poseidonUserId, roundId);
  if (!data) {
    return res.status(404).json({ status: "fail", message: "Jackpot round not found" });
  }
  res.status(200).json({ status: "success", data });
});

exports.jackpotReveal = asyncHandler(async (req, res) => {
  const { roundId, cardIndex } = req.body;
  const data = await poseidonService.executeJackpotReveal(
    req.poseidonUserId,
    roundId,
    cardIndex,
  );
  res.status(200).json({ status: "success", data });
});

// Older route files required `jackpotRevealed` — same handler.
exports.jackpotRevealed = exports.jackpotReveal;

exports.requireUserId = requireUserId;
