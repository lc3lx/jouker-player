const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const leaderboardPlatformService = require("../services/leaderboardPlatformService");
const playerAnalyticsService = require("../services/playerAnalyticsService");
const riskScoreService = require("../services/riskScoreService");

const router = express.Router();

router.get(
  "/leaderboards/:gameType",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const period = req.query.period || "weekly";
    const metric = req.query.metric || "wins";
    const data = await leaderboardPlatformService.pokerLeaderboard({
      period,
      metric,
      limit: parseInt(req.query.limit || "50", 10),
    });
    res.json({ period, metric, results: data.length, data });
  })
);

router.get(
  "/analytics/me",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const gameType = req.query.gameType || "poker";
    const data = await playerAnalyticsService.getUserAnalytics(req.user._id, gameType);
    res.json({ data });
  })
);

router.get(
  "/risk-score/:userId",
  authService.protect,
  authService.allowedTo("admin", "manager"),
  asyncHandler(async (req, res) => {
    const data = await riskScoreService.computeRiskScore(req.params.userId);
    res.json({ data });
  })
);

module.exports = router;
