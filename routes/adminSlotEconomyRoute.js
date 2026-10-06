"use strict";

const express = require("express");
const authService = require("../services/authService");
const svc = require("../services/adminSlotEconomyService");

const router = express.Router();

// Read: admins and managers. Write: admins with the games capability only.
router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/overview", svc.getOverview);
router.get("/audit", svc.auditTrail);
router.get("/games/:game/profiles", svc.listProfiles);
router.get("/games/:game/timeseries", svc.timeseries);
router.put(
  "/games/:game/settings",
  authService.allowedTo("admin"),
  authService.requirePermission("games.manage"),
  svc.updateSettings,
);

module.exports = router;
