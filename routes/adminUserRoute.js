"use strict";

/**
 * Admin player-management API for the profile popup's admin section.
 * Mounted at /api/v1/admin/users BEFORE the generic /api/v1/admin router.
 */

const express = require("express");
const authService = require("../services/authService");
const svc = require("../services/adminUserModerationService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/:id/overview", svc.adminUserOverview);
router.get("/:id/transactions", svc.adminUserTransactions);
router.get("/:id/purchases", svc.adminUserPurchases);
router.get("/:id/vip-history", svc.adminUserVipHistory);
router.get("/:id/reports", svc.adminUserReports);

router.patch("/:id/ban", svc.adminBanUser);
router.patch("/:id/unban", svc.adminUnbanUser);
router.patch("/:id/mute", svc.adminMuteUser);
router.patch("/:id/unmute", svc.adminUnmuteUser);

module.exports = router;
