const express = require("express");
const authService = require("../services/authService");
const { getMonitor, listRounds } = require("../services/adminSicboService");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/monitor", getMonitor);
router.get("/rounds", listRounds);

module.exports = router;
