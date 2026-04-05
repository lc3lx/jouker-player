const express = require("express");
const authService = require("../services/authService");
const {
  applyAgent,
  getMyAgentProfile,
  listMyReferrals,
  listAgents,
  approveAgent,
  getSettings,
  updateSettings,
  topupByAgent,
} = require("../services/agentService");

const router = express.Router();

// All routes require authentication
router.use(authService.protect);

// User routes
router.post("/apply", authService.allowedTo("user"), applyAgent);
router.get("/me", authService.allowedTo("user"), getMyAgentProfile);
router.get("/me/referrals", authService.allowedTo("user"), listMyReferrals);
router.post("/topup", authService.allowedTo("user"), topupByAgent);

// Admin/Manager routes
router.get("/", authService.allowedTo("admin", "manager"), listAgents);
router.put("/:id/approve", authService.allowedTo("admin"), approveAgent);
router.get("/settings", authService.allowedTo("admin"), getSettings);
router.put("/settings", authService.allowedTo("admin"), updateSettings);

module.exports = router;
