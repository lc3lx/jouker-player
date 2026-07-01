const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const HandHistory = require("../models/handHistoryModel");
const CardGameHistory = require("../models/cardGameHistoryModel");
const handEvidenceService = require("../services/handEvidenceService");

const router = express.Router();

router.get(
  "/search",
  authService.protect,
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const q = req.query.q || "";
    const gameType = req.query.gameType;
    const tableId = req.query.tableId;
    const page = parseInt(req.query.page || "1", 10);
    const limit = parseInt(req.query.limit || "20", 10);
    const skip = (page - 1) * limit;

    const filter = {};
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
      poker,
      cardGames: card,
    });
  })
);

router.get(
  "/evidence/:handId",
  authService.protect,
  authService.allowedTo("user"),
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
