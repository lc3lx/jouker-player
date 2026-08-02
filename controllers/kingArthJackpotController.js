/**
 * King Arth jackpot REST handlers — match-3 scratch (shared with Poseidon).
 */

const asyncHandler = require("express-async-handler");
const kingArthJackpot = require("../games/dice/kingArthJackpot");

function requireUser(req, res) {
  const userId = req.user?.id || req.user?._id;
  if (!userId) {
    res.status(401).json({ status: "fail", message: "Unauthorized" });
    return null;
  }
  return String(userId);
}

exports.jackpotRecover = asyncHandler(async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { roundId } = req.query;
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  const data = await kingArthJackpot.recoverRound(roundId, userId);
  if (!data) {
    return res
      .status(404)
      .json({ status: "fail", message: "Jackpot round not found" });
  }
  res.status(200).json({ status: "success", data });
});

exports.jackpotReveal = asyncHandler(async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { roundId, cardIndex } = req.body || {};
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  try {
    const data = await kingArthJackpot.revealCard(roundId, userId, cardIndex);
    res.status(200).json({ status: "success", data });
  } catch (err) {
    res.status(400).json({
      status: "fail",
      message: err?.message || "Reveal failed",
    });
  }
});

exports.jackpotSettle = asyncHandler(async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const { roundId } = req.body || {};
  if (!roundId) {
    return res
      .status(400)
      .json({ status: "fail", message: "roundId is required" });
  }
  const data = await kingArthJackpot.settleRound(roundId, userId);
  res.status(200).json({ status: "success", data });
});
