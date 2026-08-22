"use strict";

const express = require("express");
const authService = require("../services/authService");
const svc = require("../services/arenaTournamentAdminService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/", svc.adminList);
router.put("/catalog/:tierId", svc.adminUpdateCatalogTier);
router.patch("/:id", svc.adminUpdateTournament);
router.post("/:id/start", svc.adminStartTournament);
router.post("/:id/end", svc.adminEndTournament);

module.exports = router;
