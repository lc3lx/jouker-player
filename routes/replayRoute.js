const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const replayService = require("../services/replayService");
const HandScreenshot = require("../models/handScreenshotModel");

const router = express.Router();

router.get(
  "/hands/:handId",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const data = await replayService.getHandReplay(req.params.handId, {
      revealSeed: req.user.role === "admin",
    });
    res.json({ data });
  })
);

router.get(
  "/hands/:handId/screenshot",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const shot = await HandScreenshot.findOne({ handId: req.params.handId }).lean();
    if (!shot) return res.status(404).json({ message: "Screenshot not found" });
    res.json({ data: shot });
  })
);

module.exports = router;
