const express = require("express");
const authService = require("../services/authService");
const {
  getTracks,
  getRace,
  createRaceHandler,
  joinRaceHandler,
  getLeaderboard,
} = require("../services/parkourService");

const router = express.Router();

router.get("/tracks", getTracks);
router.get("/leaderboard", getLeaderboard);
router.get("/races/:raceId", getRace);

router.use(authService.protect, authService.allowedTo("user"));

router.post("/races", createRaceHandler);
router.post("/races/:raceId/join", joinRaceHandler);

module.exports = router;
