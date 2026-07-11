const asyncHandler = require("express-async-handler");
const poseidonService = require("../games/poseidon/poseidonService");

function requireUserId(req, res, next) {
  const userId = req.body?.userId || req.user?._id || req.user?.id;
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

exports.requireUserId = requireUserId;
