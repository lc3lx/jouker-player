const express = require("express");
const authService = require("../services/authService");
const { getStatus, contribute, settle } = require("../services/jackpotService");
const { contributeValidator, settleValidator } = require("../utils/validators/jackpotValidator");

const router = express.Router();

// Public status
router.get("/", getStatus);

// Contribute (protected)
router.post("/contribute", authService.protect, contributeValidator, contribute);

// Settle (admin/manager)
router.post(
  "/settle",
  authService.protect,
  authService.allowedTo("admin", "manager"),
  settleValidator,
  settle
);

module.exports = router;
