const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const leaderboardPlatformService = require("../services/leaderboardPlatformService");
const playerAnalyticsService = require("../services/playerAnalyticsService");
const riskScoreService = require("../services/riskScoreService");
const achievementHookService = require("../services/achievementHookService");
const Achievement = require("../models/achievementModel");
const Player = require("../models/playerModel");

const router = express.Router();

router.get(
  "/leaderboards/:gameType",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const period = req.query.period || "weekly";
    const metric = req.query.metric || "wins";
    const scope = req.query.scope || "global";
    const limit = parseInt(req.query.limit || "50", 10);
    const page = parseInt(req.query.page || "1", 10);

    let data;
    if (scope === "friends" && req.query.friendIds) {
      const ids = String(req.query.friendIds).split(",");
      data = await leaderboardPlatformService.pokerLeaderboard({ period, metric, limit: 200 });
      data = data.filter((r) => ids.includes(String(r.userId)));
    } else if (metric === "roi" || metric === "profit") {
      data = await leaderboardPlatformService.settlementProfitLeaderboard({
        period,
        gameType: req.params.gameType === "all" ? null : req.params.gameType,
        limit,
      });
    } else {
      data = await leaderboardPlatformService.pokerLeaderboard({
        period,
        metric,
        limit,
      });
    }

    const start = (page - 1) * limit;
    res.json({
      period,
      metric,
      scope,
      gameType: req.params.gameType,
      results: data.length,
      page,
      data: data.slice(start, start + limit),
    });
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
  "/analytics/me/export",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const gameType = req.query.gameType || "poker";
    const data = await playerAnalyticsService.exportUserAnalytics(req.user._id, gameType);
    res.json({ data });
  })
);

router.get(
  "/achievements",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const all = await Achievement.find({ isActive: true }).lean();
    const player = await Player.findOne({ user: req.user._id }).lean();
    const unlocked = new Set((player?.achievements || []).map((a) => String(a.achievement)));
    res.json({
      results: all.length,
      data: all.map((a) => ({
        ...a,
        unlocked: unlocked.has(String(a._id)),
      })),
    });
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
