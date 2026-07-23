"use strict";

/**
 * Admin Clan-management API (REST-only surface, consumed by the external admin
 * panel). Mounted at /api/v1/admin/clans BEFORE the generic /api/v1/admin router.
 * Every mutation is written to the audit log by clanAdminService.
 */

const express = require("express");
const authService = require("../services/authService");
const svc = require("../services/clanAdminService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

// config (creation cost, limits, permission matrix)
router.get("/config", svc.adminGetConfig);
router.put("/config", svc.adminUpdateConfig);

// aggregate stats
router.get("/stats", svc.adminStats);

// chat moderation
router.patch("/chat/:messageId", svc.adminModerateMessage);

// list / create
router.get("/", svc.adminListClans);
router.post("/", svc.adminCreateClan);

// single clan
router.get("/:id", svc.adminGetClan);
router.patch("/:id", svc.adminEditClan);
router.delete("/:id", svc.adminDeleteClan);
router.patch("/:id/rename", svc.adminRenameClan);
router.patch("/:id/ban", svc.adminBanClan);
router.patch("/:id/restore", svc.adminRestoreClan);
router.post("/:id/transfer", svc.adminTransferOwnership);
router.patch("/:id/treasury", svc.adminAdjustTreasury);
router.get("/:id/chat", svc.adminListClanChat);

// members
router.patch("/:id/members/:userId/role", svc.adminSetMemberRole);
router.delete("/:id/members/:userId", svc.adminKickMember);

module.exports = router;
