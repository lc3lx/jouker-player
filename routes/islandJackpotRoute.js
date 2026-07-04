const express = require("express");
const authService = require("../services/authService");
const {
  getIslandStatus,
  joinIslandJackpot,
  getIslandHistory,
  getIslandWinners,
  getIslandLeaderboard,
} = require("../services/islandJackpotService");

const router = express.Router();

router.get("/status", getIslandStatus);
router.get("/history", getIslandHistory);
router.get("/winners", getIslandWinners);
router.get("/leaderboard", getIslandLeaderboard);

router.post("/join", authService.protect, authService.allowedTo("user"), joinIslandJackpot);

module.exports = router;
