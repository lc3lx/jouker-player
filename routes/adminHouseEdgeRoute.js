"use strict";

const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const config = require("../games/utils/houseEdgeConfig");
const { getPlayerRollingRtp, evaluateStreak } = require("../games/utils/rtpTracker");
const CasinoGameStats = require("../models/casinoGameStatsModel");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

/**
 * GET /api/v1/admin/house-edge/config
 * Read active House Edge & Tier configuration
 */
router.get(
  "/config",
  asyncHandler(async (req, res) => {
    res.status(200).json({
      status: "success",
      data: {
        enabled: config.ENABLED,
        tiers: config.TIERS,
        adaptive: config.ADAPTIVE,
      },
    });
  })
);

/**
 * PUT /api/v1/admin/house-edge/config
 * Update House Edge configuration in-memory
 */
router.put(
  "/config",
  asyncHandler(async (req, res) => {
    const { enabled, tiers, adaptive } = req.body;
    if (typeof enabled === "boolean") config.ENABLED = enabled;
    if (Array.isArray(tiers)) config.TIERS = tiers;
    if (adaptive && typeof adaptive === "object") {
      Object.assign(config.ADAPTIVE, adaptive);
    }

    res.status(200).json({
      status: "success",
      message: "House edge configuration updated successfully",
      data: {
        enabled: config.ENABLED,
        tiers: config.TIERS,
        adaptive: config.ADAPTIVE,
      },
    });
  })
);

/**
 * GET /api/v1/admin/house-edge/stats
 * View realized RTP and spin volume per game
 */
router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const docs = await CasinoGameStats.find({}).lean();
    const stats = docs.map((doc) => {
      const rtp = doc.totalBet > 0 ? doc.totalPayout / doc.totalBet : 0;
      return {
        gameKey: doc.gameKey,
        totalBet: doc.totalBet,
        totalPayout: doc.totalPayout,
        spinCount: doc.spinCount,
        bigWinCount: doc.bigWinCount,
        megaWinCount: doc.megaWinCount,
        realizedRtp: Number((rtp * 100).toFixed(2)),
        houseProfit: doc.totalBet - doc.totalPayout,
        updatedAt: doc.updatedAt,
      };
    });

    res.status(200).json({
      status: "success",
      data: { stats },
    });
  })
);

/**
 * GET /api/v1/admin/house-edge/player/:userId
 * Inspect a player's recent rolling session RTP & streak evaluation
 */
router.get(
  "/player/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const rolling = getPlayerRollingRtp(userId);
    const streak = evaluateStreak(userId);

    res.status(200).json({
      status: "success",
      data: {
        userId,
        rollingStats: rolling,
        streakEvaluation: streak,
      },
    });
  })
);

module.exports = router;
