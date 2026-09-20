"use strict";

const express = require("express");
const asyncHandler = require("express-async-handler");

const authService = require("../services/authService");
const playerIdService = require("../services/playerIdService");
const specialPlayerIdService = require("../services/specialPlayerIdService");
const User = require("../models/userModel");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("user"));

/** The vanity numbers currently on sale. */
router.get(
  "/store",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.listStore({
      page: req.query.page,
      limit: req.query.limit,
      minPrice: req.query.minPrice,
      maxPrice: req.query.maxPrice,
      tier: req.query.tier,
    });
    res.status(200).json({ status: "success", data });
  })
);

/** The caller's own number, allocating one if they somehow have none. */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user._id).select("playerId").lean();
    let playerId = typeof user?.playerId === "number" ? user.playerId : null;
    if (playerId === null) {
      playerId = await playerIdService.ensurePlayerId(req.user._id);
    }
    res.status(200).json({
      status: "success",
      data: {
        playerId,
        specialMin: playerIdService.SPECIAL_ID_MIN,
        specialMax: playerIdService.SPECIAL_ID_MAX,
        isSpecial:
          playerId !== null &&
          playerId >= playerIdService.SPECIAL_ID_MIN &&
          playerId <= playerIdService.SPECIAL_ID_MAX,
      },
    });
  })
);

router.get(
  "/store/:number",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.getListed(req.params.number);
    res.status(200).json({ status: "success", data });
  })
);

/** Buy a vanity number. `requestKey` makes a double-submit safe. */
router.post(
  "/purchase",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.purchaseSpecialId({
      userId: req.user._id,
      number: req.body?.number,
      requestKey: req.body?.requestKey,
    });
    res.status(200).json({ status: "success", data });
  })
);

module.exports = router;
