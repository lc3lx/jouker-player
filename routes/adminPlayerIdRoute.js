"use strict";

const express = require("express");
const asyncHandler = require("express-async-handler");

const authService = require("../services/authService");
const auditService = require("../services/auditService");
const playerIdService = require("../services/playerIdService");
const specialPlayerIdService = require("../services/specialPlayerIdService");
const playerProfileService = require("../services/playerProfileService");
const RetiredPlayerId = require("../models/retiredPlayerIdModel");
const User = require("../models/userModel");
const ApiError = require("../utils/apiError");
const { withMongoTransaction } = require("../services/walletLedgerService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

/* ---------------------------------------------------------- the catalog -- */

router.get(
  "/specials",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.adminList({
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.status(200).json({ status: "success", data });
  })
);

router.post(
  "/specials",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.adminListOne({
      number: req.body?.number,
      price: req.body?.price,
      label: req.body?.label,
      tier: req.body?.tier,
      actorId: req.user._id,
    });
    res.status(201).json({ status: "success", data });
  })
);

router.post(
  "/specials/bulk",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.adminListRange({
      from: req.body?.from,
      to: req.body?.to,
      price: req.body?.price,
      tier: req.body?.tier,
      actorId: req.user._id,
    });
    res.status(200).json({ status: "success", data });
  })
);

router.patch(
  "/specials/:number",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.adminUpdate({
      number: req.params.number,
      price: req.body?.price,
      label: req.body?.label,
      tier: req.body?.tier,
      status: req.body?.status,
      actorId: req.user._id,
    });
    res.status(200).json({ status: "success", data });
  })
);

router.delete(
  "/specials/:number",
  asyncHandler(async (req, res) => {
    const data = await specialPlayerIdService.adminUpdate({
      number: req.params.number,
      status: "withdrawn",
      actorId: req.user._id,
    });
    res.status(200).json({ status: "success", data });
  })
);

/* --------------------------------------------------------- the burn list -- */

router.get(
  "/retired",
  asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [items, total] = await Promise.all([
      RetiredPlayerId.find({})
        .sort({ retiredAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      RetiredPlayerId.countDocuments({}),
    ]);
    res.status(200).json({
      status: "success",
      data: { items, total, page, limit },
    });
  })
);

/* ------------------------------------------------- place a player's number -- */

/**
 * Put a player on a specific number. This is how staff and agents get into
 * 1-100, and how any player's number is corrected.
 */
router.put(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const number = playerIdService.normalizeNumber(req.body?.number);
    if (number === null) throw new ApiError("رقم غير صالح", 400);

    if (await playerIdService.isRetired(number)) {
      // Retired means retired. There is no force flag on purpose: the whole
      // value of the guarantee is that it has no exceptions.
      throw new ApiError("هذا الرقم متقاعد ولا يمكن إعطاؤه لأحد", 409);
    }
    const holder = await User.findOne({ playerId: number }).select("_id").lean();
    if (holder && String(holder._id) !== String(req.params.id)) {
      throw new ApiError("هذا الرقم مملوك للاعب آخر", 409);
    }

    const result = await withMongoTransaction(async (session) => {
      if (!session) throw new Error("MONGO_TRANSACTIONS_REQUIRED");
      const assigned = await playerIdService.assignPlayerId({
        session,
        userId: req.params.id,
        number,
        reason: "admin_change",
        meta: { by: String(req.user._id), reason: req.body?.reason || null },
      });

      const SpecialPlayerId = require("../models/specialPlayerIdModel");
      if (
        number >= playerIdService.SPECIAL_ID_MIN &&
        number <= playerIdService.SPECIAL_ID_MAX
      ) {
        // Take it off the market — it now has an owner.
        await SpecialPlayerId.updateOne(
          { number },
          {
            $set: {
              status: "sold",
              owner: req.params.id,
              acquiredVia: "admin",
              soldAt: new Date(),
              soldPrice: 0,
            },
            $setOnInsert: { price: 0, listedBy: req.user._id },
          },
          { session, upsert: true }
        );
      }
      if (
        assigned.previousPlayerId !== null &&
        assigned.previousPlayerId >= playerIdService.SPECIAL_ID_MIN &&
        assigned.previousPlayerId <= playerIdService.SPECIAL_ID_MAX
      ) {
        await SpecialPlayerId.updateOne(
          { number: assigned.previousPlayerId },
          { $set: { status: "retired", owner: null } },
          { session }
        );
      }
      return assigned;
    });

    // Outside the transaction: withTransaction replays its callback, and the
    // counter bump plus the audit row must each happen once.
    if (number >= playerIdService.ORDINARY_ID_MIN) {
      // Without this the allocator would hand this same number to a future
      // signup — the counter has no idea an admin reached past it.
      await playerIdService.bumpCounterFloor(number);
    }
    playerProfileService.invalidate(req.params.id);
    await auditService.logEvent({
      event: "admin_player_id_changed",
      actor: req.user._id,
      targetUser: req.params.id,
      meta: {
        from: result.previousPlayerId,
        to: result.playerId,
        reason: req.body?.reason || null,
      },
    });

    res.status(200).json({ status: "success", data: result });
  })
);

module.exports = router;
