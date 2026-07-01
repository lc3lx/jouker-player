const express = require("express");
const authService = require("../services/authService");
const {
  adminListTables,
  adminListPlayers,
  adminListTransactions,
  adminRealtimeTables,
  adminForceEndHand,
} = require("../services/adminService");
const {
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminListCosmetics,
  adminGetCosmetic,
  adminCreateCosmetic,
  adminUpdateCosmetic,
  adminDeleteCosmetic,
} = require("../services/adminCosmeticsService");
const {
  adminGetCurrencySettings,
  adminUpdateCurrencySettings,
} = require("../services/currencySettingsService");
const { adminListGameSettlements } = require("../services/gameSettlementService");
const AuditLog = require("../models/auditLogModel");
const HandScreenshot = require("../models/handScreenshotModel");
const HandHistory = require("../models/handHistoryModel");
const asyncHandler = require("express-async-handler");

const router = express.Router();

router.use(authService.protect, authService.allowedTo("admin", "manager"));

router.get("/tables", adminListTables);
router.get("/realtime-tables", adminRealtimeTables);
router.post("/force-end-hand", adminForceEndHand);
router.get("/players", adminListPlayers);
router.get("/transactions", adminListTransactions);

router.get("/cosmetics", adminListCosmetics);
router.get("/cosmetics/:id", adminGetCosmetic);
router.post(
  "/cosmetics",
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminCreateCosmetic
);
router.put(
  "/cosmetics/:id",
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminUpdateCosmetic
);
router.delete("/cosmetics/:id", adminDeleteCosmetic);

router.get("/currency-settings", adminGetCurrencySettings);
router.put("/currency-settings", adminUpdateCurrencySettings);

router.get("/game-settlements", adminListGameSettlements);

router.get(
  "/audit-logs",
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page || "1", 10);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.event) filter.event = req.query.event;
    if (req.query.handId) filter.handId = req.query.handId;
    const total = await AuditLog.countDocuments(filter);
    const data = await AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();
    res.json({ results: data.length, total, data });
  })
);

router.get(
  "/hand-screenshots",
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
    const data = await HandScreenshot.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ results: data.length, data });
  })
);

router.get(
  "/hand-history/:handId",
  asyncHandler(async (req, res) => {
    const doc = await HandHistory.findOne({ handId: req.params.handId }).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ data: doc });
  })
);

module.exports = router;

