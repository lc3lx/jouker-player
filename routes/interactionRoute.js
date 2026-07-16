const express = require("express");
const asyncHandler = require("express-async-handler");
const authService = require("../services/authService");
const svc = require("../services/tableInteractionsService");

const router = express.Router();

router.use(authService.protect);

/** Shop / picker catalog. */
router.get(
  "/catalog",
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const items = await svc.listCatalog();
    res.status(200).json({ status: "success", data: { items } });
  })
);

/** My owned items (consumable stock + permanent ownership). */
router.get(
  "/inventory",
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const inventory = await svc.getInventory(req.user._id);
    res.status(200).json({ status: "success", data: { inventory } });
  })
);

/** Buy consumable stock or permanent ownership (Coins deducted atomically). */
router.post(
  "/purchase",
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const { itemKey, quantity, mode } = req.body || {};
    const result = await svc.purchaseItem({
      userId: req.user._id,
      itemKey: String(itemKey || ""),
      quantity: Number(quantity || 1),
      mode: mode === "unlimited" ? "unlimited" : "consumable",
    });
    if (!result.ok) {
      return res.status(400).json({ status: "fail", message: result.reason });
    }
    res.status(200).json({ status: "success", data: result });
  })
);

/** Report a player (from the profile popup) — persisted for support review. */
router.post(
  "/report",
  authService.allowedTo("user"),
  asyncHandler(async (req, res) => {
    const PlayerReport = require("../models/playerReportModel");
    const { reportedUserId, tableId, gameType, reason } = req.body || {};
    if (!reportedUserId) {
      return res.status(400).json({ status: "fail", message: "reportedUserId required" });
    }
    // Light anti-spam: one open report per reporter→reported pair.
    const existing = await PlayerReport.findOne({
      reporter: req.user._id,
      reported: reportedUserId,
      status: "open",
    });
    if (!existing) {
      await PlayerReport.create({
        reporter: req.user._id,
        reported: reportedUserId,
        tableId: tableId ? String(tableId) : null,
        gameType: gameType ? String(gameType) : null,
        reason: String(reason || "unspecified").slice(0, 300),
      });
    }
    res.status(200).json({ status: "success" });
  })
);

/** Admin gift — rewards entry point (source: admin_gift). */
router.post(
  "/admin/grant",
  authService.allowedTo("admin"),
  asyncHandler(async (req, res) => {
    const { userId, itemKey, quantity, unlimited, source } = req.body || {};
    if (!userId || !itemKey) {
      return res.status(400).json({ status: "fail", message: "userId and itemKey required" });
    }
    await svc.grantItem({
      userId,
      itemKey: String(itemKey),
      quantity: Number(quantity || 1),
      unlimited: unlimited === true,
      source: String(source || "admin_gift"),
    });
    res.status(200).json({ status: "success" });
  })
);

module.exports = router;
