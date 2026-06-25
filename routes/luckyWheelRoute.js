const express = require("express");
const authService = require("../services/authService");
const {
  getLuckyWheelStatus,
  spinLuckyWheel,
  getLuckyWheelHistory,
} = require("../services/luckyWheelService");

const router = express.Router();

router.use(authService.protect);

router.get("/status", authService.allowedTo("user"), getLuckyWheelStatus);
router.post("/spin", authService.allowedTo("user"), spinLuckyWheel);
router.get("/history", authService.allowedTo("user"), getLuckyWheelHistory);

module.exports = router;
