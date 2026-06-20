const asyncHandler = require("express-async-handler");
const goldenTreeService = require("../games/goldenTree/goldenTreeService");

function requireUserId(req, res, next) {
  const userId = req.body?.userId || req.user?._id || req.user?.id;
  if (!userId) {
    return res.status(400).json({
      status: "fail",
      message: "userId is required",
    });
  }
  req.goldenTreeUserId = String(userId);
  return next();
}

exports.spin = asyncHandler(async (req, res) => {
  const { betAmount } = req.body;
  const data = await goldenTreeService.executeSpin(req.goldenTreeUserId, betAmount);
  res.status(200).json({ status: "success", data });
});

exports.gamble = asyncHandler(async (req, res) => {
  const { roundId, choice } = req.body;
  if (!roundId) {
    return res.status(400).json({ status: "fail", message: "roundId is required" });
  }
  const data = await goldenTreeService.executeGamble(
    req.goldenTreeUserId,
    roundId,
    choice,
  );
  res.status(200).json({ status: "success", data });
});

exports.buyBonus = asyncHandler(async (req, res) => {
  const { bonusType, currentBet } = req.body;
  const data = await goldenTreeService.executeBuyBonus(
    req.goldenTreeUserId,
    bonusType,
    currentBet,
  );
  res.status(200).json({ status: "success", data });
});

exports.requireUserId = requireUserId;
