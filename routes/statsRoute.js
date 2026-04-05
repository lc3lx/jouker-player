const express = require("express");
const authService = require("../services/authService");
const {
  getMyStats,
  getCountryRanking,
  getBalanceLeaderboard,
  getWeeklyPokerWinsLeaderboard,
  claimDailyBonus,
  getPokerRetention,
} = require("../services/statsService");

const router = express.Router();

router.get("/me", authService.protect, getMyStats);
router.get("/country", authService.protect, getCountryRanking);
router.get("/leaderboard/balance", authService.protect, getBalanceLeaderboard);
router.get("/leaderboard/poker-weekly", authService.protect, getWeeklyPokerWinsLeaderboard);
router.get("/poker-retention", authService.protect, getPokerRetention);
router.post("/daily-bonus", authService.protect, claimDailyBonus);

module.exports = router;
