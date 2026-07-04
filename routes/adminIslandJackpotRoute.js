const express = require("express");
const authService = require("../services/authService");
const {
  adminGetConfig,
  adminUpdateConfig,
  adminResetPool,
  adminGetStatistics,
} = require("../services/islandJackpotService");
const { adminUpdateConfigValidator } = require("../utils/validators/islandJackpotValidator");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/config", adminGetConfig);
router.put("/config", adminUpdateConfigValidator, adminUpdateConfig);
router.post("/reset", adminResetPool);
router.get("/statistics", adminGetStatistics);

module.exports = router;
