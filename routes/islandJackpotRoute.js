const express = require("express");
const authService = require("../services/authService");
const {
  getIslandStatus,
  joinIslandJackpot,
  setIslandAutoBuy,
  getIslandHistory,
  getIslandWinners,
  getIslandLeaderboard,
} = require("../services/islandJackpotService");

const router = express.Router();

router.get("/status", authService.protect, getIslandStatus);
router.get("/history", getIslandHistory);
router.get("/winners", getIslandWinners);
router.get("/leaderboard", getIslandLeaderboard);

router.post("/join", authService.protect, authService.allowedTo("user"), joinIslandJackpot);
router.post("/auto-buy", authService.protect, authService.allowedTo("user"), setIslandAutoBuy);

module.exports = router;
