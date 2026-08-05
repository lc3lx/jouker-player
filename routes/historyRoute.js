const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const HandHistory = require("../models/handHistoryModel");
const CardGameHistory = require("../models/cardGameHistoryModel");
const handEvidenceService = require("../services/handEvidenceService");
const {
  isStaff,
  participantFilter,
  redactHistoryForPlayer,
} = require("../services/handHistoryService");

const router = express.Router();

router.get(
  "/search",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const q = req.query.q || "";
    const gameType = req.query.gameType;
    const tableId = req.query.tableId;
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10) || 20));
    const skip = (page - 1) * limit;

    const staff = isStaff(req.user);
    // Normal users may search only hands in which they participated. This
    // route used to expose every poker hand (including private audit data) to
    // any authenticated account.
    const filter = staff ? {} : participantFilter(req.user._id);
    if (gameType) filter.gameType = gameType;
    if (tableId) filter.table = tableId;
    if (q.trim()) filter.$text = { $search: q.trim() };

    const [poker, card] = await Promise.all([
      HandHistory.find(filter).sort({ endedAt: -1 }).skip(skip).limit(limit).lean(),
      CardGameHistory.find(filter).sort({ endedAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    res.json({
      results: poker.length + card.length,
      page,
      limit,
      poker: poker.map((hand) => redactHistoryForPlayer(hand, req.user._id, { staff })),
      cardGames: card,
    });
  })
);

router.get(
  "/evidence/:handId",
  authService.protect,
  // Evidence packages intentionally retain all hole cards for support. They
  // are therefore not a player-facing API.
  authService.allowedTo("admin", "manager"),
  asyncHandler(async (req, res) => {
    const data = await handEvidenceService.getEvidenceByHandId(req.params.handId);
    if (!data) return res.status(404).json({ message: "Evidence not found" });
    res.json({ data });
  })
);

router.get(
  "/evidence",
  authService.protect,
  authService.allowedTo("admin", "manager"),
  asyncHandler(async (req, res) => {
    const data = await handEvidenceService.searchEvidence({
      q: req.query.q,
      gameType: req.query.gameType,
      tableId: req.query.tableId,
      page: parseInt(req.query.page || "1", 10),
      limit: parseInt(req.query.limit || "20", 10),
    });
    res.json(data);
  })
);

module.exports = router;
