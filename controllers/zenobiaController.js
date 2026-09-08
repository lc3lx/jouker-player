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

exports.requireUserId = requireUserId;
