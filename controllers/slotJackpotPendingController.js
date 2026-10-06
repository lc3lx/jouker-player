"use strict";

const asyncHandler = require("express-async-handler");
const jackpotService = require("../games/poseidon/jackpot/jackpotService");

/**
 * GET …/jackpot/pending — the player's unsettled jackpot rounds for one game,
 * so a client that reconnects can resume the scratch board instead of losing
 * the prize. `game` is the jackpot round's game key.
 */
exports.pendingFor = (game) => asyncHandler(async (req, res) => {
  const userId = req.user?._id || req.user?.id;
  if (!userId) {
    return res.status(401).json({ status: "fail", message: "Unauthorized" });
  }
  const data = await jackpotService.listPendingRounds(String(userId), game);
  return res.status(200).json({ status: "success", results: data.length, data });
});
