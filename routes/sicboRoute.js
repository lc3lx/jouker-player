const express = require("express");
const authService = require("../services/authService");
const {
  getState,
  getHistory,
  getMyBets,
  verify,
} = require("../services/sicboPublicService");

const router = express.Router();

router.use(authService.protect);

router.get("/state", authService.allowedTo("user"), getState);
router.get("/history", authService.allowedTo("user"), getHistory);
router.get("/my-bets", authService.allowedTo("user"), getMyBets);
router.get("/verify/:roundId", authService.allowedTo("user"), verify);

module.exports = router;
