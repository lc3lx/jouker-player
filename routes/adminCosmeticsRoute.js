"use strict";

/**
 * Cosmetics CMS admin API — data-driven catalog + store categories + equip slots
 * + lifecycle + bulk. Mounted at /api/v1/admin/cosmetics BEFORE the generic
 * /api/v1/admin router. Sub-resource paths (/categories, /slots, /bulk) are
 * declared before /:id so they are never captured as an id.
 *
 * Reuses the existing upload/resize pipeline and admin cosmetics handlers.
 */

const express = require("express");
const authService = require("../services/authService");
const {
  uploadCosmeticPreview,
  resizeCosmeticPreview,
  adminListCosmetics,
  adminGetCosmetic,
  adminCreateCosmetic,
  adminUpdateCosmetic,
  adminDeleteCosmetic,
  adminPublishCosmetic,
  adminDisableCosmetic,
  adminArchiveCosmetic,
  adminRestoreCosmetic,
  adminBulkCosmetics,
  adminListCategories,
  adminCreateCategory,
  adminUpdateCategory,
  adminListSlots,
  adminCreateSlot,
  adminUpdateSlot,
} = require("../services/adminCosmeticsService");

const router = express.Router();
router.use(authService.protect, authService.allowedTo("admin", "manager"));

// Store categories (dynamic store sections).
router.get("/categories", adminListCategories);
router.post("/categories", adminCreateCategory);
router.put("/categories/:key", adminUpdateCategory);

// Equip slots (unlimited).
router.get("/slots", adminListSlots);
router.post("/slots", adminCreateSlot);
router.put("/slots/:key", adminUpdateSlot);

// Bulk.
router.post("/bulk", adminBulkCosmetics);

// Catalog CRUD.
router.get("/", adminListCosmetics);
router.post("/", uploadCosmeticPreview, resizeCosmeticPreview, adminCreateCosmetic);
router.get("/:id", adminGetCosmetic);
router.put("/:id", uploadCosmeticPreview, resizeCosmeticPreview, adminUpdateCosmetic);
router.delete("/:id", adminDeleteCosmetic);

// Lifecycle.
router.patch("/:id/publish", adminPublishCosmetic);
router.patch("/:id/disable", adminDisableCosmetic);
router.patch("/:id/archive", adminArchiveCosmetic);
router.patch("/:id/restore", adminRestoreCosmetic);

module.exports = router;
