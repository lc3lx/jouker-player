const express = require("express");
const authService = require("../services/authService");
const bot = require("../services/botAdminService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

// Global config + managed avatar catalog.
router.get("/config", bot.adminGetConfig);
router.put("/config", bot.adminUpdateConfig);
router.get("/avatars", bot.adminGetAvatarCatalog);
router.put("/avatars", bot.adminUpdateAvatarCatalog);

// Catalog CRUD.
router.get("/", bot.adminListBots);
router.post("/", bot.adminCreateBot);
router.get("/:id", bot.adminGetBot);
router.patch("/:id", bot.adminUpdateBot);
router.post("/:id/enabled", bot.adminSetBotEnabled);
router.delete("/:id", bot.adminDeleteBot);

module.exports = router;
