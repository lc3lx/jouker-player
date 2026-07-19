"use strict";

const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const giftService = require("../services/giftService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("user"));

/** Send a gift to another player. Body: { type: coins|cosmetic|vip, ...payload } */
router.post(
  "/:targetId",
  asyncHandler(async (req, res) => {
    const result = await giftService.sendGift({
      senderId: req.user._id,
      targetId: req.params.targetId,
      type: req.body?.type,
      amount: req.body?.amount,
      cosmeticId: req.body?.cosmeticId,
      level: req.body?.level,
      days: req.body?.days,
    });
    res.status(200).json({ status: "success", data: result });
  })
);

module.exports = router;
