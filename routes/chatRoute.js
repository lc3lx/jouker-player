const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const chatService = require("../services/chatService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("user"));

router.get("/:channel/:channelId", asyncHandler(async (req, res) => {
  const data = await chatService.getHistory({
    channel: req.params.channel,
    channelId: req.params.channelId,
    before: req.query.before,
    limit: parseInt(req.query.limit || "50", 10),
  });
  res.json({ results: data.length, data });
}));

router.post("/:channel/:channelId", asyncHandler(async (req, res) => {
  const msg = await chatService.sendMessage({
    senderId: req.user._id,
    channel: req.params.channel,
    channelId: req.params.channelId,
    body: req.body.body,
    emoji: req.body.emoji,
    recipientId: req.body.recipientId,
  });
  res.status(201).json({ data: msg });
}));

router.post("/report/:messageId", asyncHandler(async (req, res) => {
  const data = await chatService.reportMessage(
    req.user._id,
    req.params.messageId,
    req.body.reason
  );
  res.json({ data });
}));

module.exports = router;
