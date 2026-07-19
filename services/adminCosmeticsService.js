const path = require("path");
const fs = require("fs");
const asyncHandler = require("express-async-handler");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const mongoose = require("mongoose");

const ApiError = require("../utils/apiError");
const Cosmetic = require("../models/cosmeticModel");
const CosmeticCategory = require("../models/cosmeticCategoryModel");
const CosmeticSlot = require("../models/cosmeticSlotModel");
const { uploadSingleImage } = require("../middlewares/uploadImageMiddleware");
const { publicCosmeticDisplay } = require("./cosmeticsService");
const cosmeticsLive = require("./cosmeticsLive");
const economyAudit = require("./economyAuditService");

// Known defaults for hints/UX only — type/rarity/category/slot are DATA-DRIVEN
// (free strings) so new kinds never require a code change.
const RENDER_TYPES = new Set(Cosmetic.RENDER_TYPES);
const STATUSES = new Set(Cosmetic.STATUSES);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function toObjectId(id) {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
}

function assertAssetKey(assetKey) {
  const k = String(assetKey || "").trim();
  if (k.length < 1 || k.length > 64) {
    throw new ApiError("Invalid cosmetic asset key", 400);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(k)) {
    throw new ApiError("Invalid cosmetic asset key", 400);
  }
  return k;
}

function parseBool(v, fallback = false) {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return fallback;
}

function parsePromoMeta(raw) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new ApiError("Invalid promoMeta JSON", 400);
  }
}

function parseBundleItems(raw) {
  if (raw == null || raw === "") return undefined;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return undefined;
}

/** Parse a games/tags list from JSON array or comma string. */
function parseStringArray(raw) {
  if (raw == null || raw === "") return undefined;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return undefined;
}

function parseDate(v) {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildCosmeticBody(req, { partial = false } = {}) {
  const body = {};
  const setIfPresent = (key, transform = (v) => v) => {
    if (partial && typeof req.body[key] === "undefined") return;
    if (typeof req.body[key] !== "undefined") body[key] = transform(req.body[key]);
  };

  setIfPresent("name", (v) => String(v || "").trim());
  setIfPresent("nameAr", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("description", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("type", (v) => String(v || "").trim());
  setIfPresent("category", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("slot", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("assetKey", assertAssetKey);
  setIfPresent("price", (v) => Math.max(0, Math.floor(Number(v) || 0)));
  setIfPresent("currencyId", (v) => String(v || "coins").trim());
  setIfPresent("rarity", (v) => String(v || "common").trim());
  setIfPresent("renderType", (v) => String(v || "png").trim().toLowerCase());
  setIfPresent("animatedAssetKey", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("animationUrl", (v) => (v == null ? null : String(v).trim()));
  setIfPresent("vipLevelRequired", (v) => (v ? String(v).trim().toLowerCase() : null));
  setIfPresent("season", (v) => (v ? String(v).trim() : null));
  setIfPresent("limitedEdition", (v) => parseBool(v, false));
  setIfPresent("isActive", (v) => parseBool(v, true));
  setIfPresent("status", (v) => String(v || "").trim().toLowerCase());
  setIfPresent("featured", (v) => parseBool(v, false));
  setIfPresent("featuredOrder", (v) => Math.floor(Number(v) || 0));
  setIfPresent("sortOrder", (v) => Math.floor(Number(v) || 0));

  const games = parseStringArray(req.body.games);
  if (games) body.games = games;
  if (typeof req.body.startDate !== "undefined") body.startDate = parseDate(req.body.startDate);
  if (typeof req.body.endDate !== "undefined") body.endDate = parseDate(req.body.endDate);

  if (!partial || typeof req.body.promoMeta !== "undefined") {
    const meta = parsePromoMeta(req.body.promoMeta);
    if (meta !== undefined) body.promoMeta = meta;
  }

  if (req.file) {
    body.previewImage = req.body.previewImage;
  } else if (!partial && req.body.previewImage) {
    body.previewImage = String(req.body.previewImage).trim();
  }

  // Data-driven: type/rarity/category/slot are free strings. Only validate
  // render type + status against their known value sets.
  if (body.renderType && !RENDER_TYPES.has(body.renderType)) {
    throw new ApiError(`Invalid renderType (expected one of ${[...RENDER_TYPES].join(", ")})`, 400);
  }
  if (body.status && !STATUSES.has(body.status)) {
    throw new ApiError(`Invalid status (expected one of ${[...STATUSES].join(", ")})`, 400);
  }
  // findByIdAndUpdate bypasses the pre-save mirror → keep isActive/status aligned.
  if (body.status) body.isActive = body.status === "published";
  else if (typeof body.isActive === "boolean" && !partial) body.status = body.isActive ? "published" : "disabled";

  if (body.type === "bundle") {
    const items = parseBundleItems(req.body.bundleItems ?? req.body.bundleGrants);
    if (items && items.length > 0) {
      body.promoMeta = {
        ...(body.promoMeta || {}),
        items: items.map((id) => toObjectId(id)).filter(Boolean),
      };
    }
  }

  return body;
}

exports.uploadCosmeticPreview = uploadSingleImage("previewImage");

exports.resizeCosmeticPreview = asyncHandler(async (req, res, next) => {
  if (!req.file) return next();
  const uploadsDir = path.join("uploads", "cosmetics");
  ensureDir(uploadsDir);
  const filename = `cosmetic-${uuidv4()}-${Date.now()}.jpeg`;

  await sharp(req.file.buffer)
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .toFormat("jpeg")
    .jpeg({ quality: 90 })
    .toFile(path.join(uploadsDir, filename));

  req.body.previewImage = filename;
  next();
});

exports.adminListCosmetics = asyncHandler(async (req, res) => {
  const q = req.query || {};
  const filter = {};
  if (q.type) filter.type = String(q.type);
  if (q.category) filter.category = String(q.category);
  if (q.slot) filter.slot = String(q.slot);
  if (q.status) filter.status = String(q.status);
  if (q.game) filter.games = String(q.game);
  if (q.rarity) filter.rarity = String(q.rarity);
  if (q.vipLevelRequired) filter.vipLevelRequired = String(q.vipLevelRequired);
  if (q.isActive === "true") filter.isActive = true;
  if (q.isActive === "false") filter.isActive = false;
  if (q.q) {
    const rx = new RegExp(String(q.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { nameAr: rx }, { assetKey: rx }, { type: rx }, { category: rx }];
  }

  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(500, Math.max(1, parseInt(q.limit || "200", 10)));
  const [total, rows] = await Promise.all([
    Cosmetic.countDocuments(filter),
    Cosmetic.find(filter)
      .sort({ sortOrder: 1, type: 1, featuredOrder: 1, name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  const data = rows.map(publicCosmeticDisplay).filter(Boolean);
  res.status(200).json({ status: "success", results: data.length, total, page, limit, data });
});

exports.adminGetCosmetic = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  if (!id) return next(new ApiError("Invalid cosmetic id", 400));
  const row = await Cosmetic.findById(id).lean();
  if (!row) return next(new ApiError("Cosmetic not found", 404));
  res.status(200).json({ status: "success", data: publicCosmeticDisplay(row) });
});

exports.adminCreateCosmetic = asyncHandler(async (req, res, next) => {
  const body = buildCosmeticBody(req);
  if (!body.name) return next(new ApiError("Name is required", 400));
  if (!body.type) return next(new ApiError("Type is required", 400));
  if (!body.assetKey) return next(new ApiError("assetKey is required", 400));

  const exists = await Cosmetic.findOne({ type: body.type, assetKey: body.assetKey }).lean();
  if (exists) return next(new ApiError("Cosmetic with this type and assetKey already exists", 409));

  const doc = await Cosmetic.create(body);
  await economyAudit.record({ req, action: "create", entity: "cosmetic", entityId: String(doc._id), after: doc.toObject() });
  cosmeticsLive.refresh({ reason: "cosmetic_create", keys: [String(doc._id)] });
  res.status(201).json({ status: "success", data: publicCosmeticDisplay(doc.toObject()) });
});

exports.adminUpdateCosmetic = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  if (!id) return next(new ApiError("Invalid cosmetic id", 400));

  const body = buildCosmeticBody(req, { partial: true });
  if (body.type && body.assetKey) {
    const clash = await Cosmetic.findOne({
      _id: { $ne: id },
      type: body.type,
      assetKey: body.assetKey,
    }).lean();
    if (clash) return next(new ApiError("Cosmetic with this type and assetKey already exists", 409));
  }

  const before = await Cosmetic.findById(id).lean();
  const doc = await Cosmetic.findByIdAndUpdate(id, body, { new: true, runValidators: true }).lean();
  if (!doc) return next(new ApiError("Cosmetic not found", 404));
  await economyAudit.record({ req, action: "update", entity: "cosmetic", entityId: String(id), before, after: doc, reason: req.body?.reason });
  cosmeticsLive.refresh({ reason: "cosmetic_update", keys: [String(id)] });
  res.status(200).json({ status: "success", data: publicCosmeticDisplay(doc) });
});

exports.adminDeleteCosmetic = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  if (!id) return next(new ApiError("Invalid cosmetic id", 400));

  // Soft delete — never hard-remove owned/equipped cosmetics.
  const before = await Cosmetic.findById(id).lean();
  const doc = await Cosmetic.findByIdAndUpdate(id, { isActive: false, status: "archived" }, { new: true }).lean();
  if (!doc) return next(new ApiError("Cosmetic not found", 404));
  await economyAudit.record({ req, action: "archive", entity: "cosmetic", entityId: String(id), before, after: doc, reason: req.body?.reason });
  cosmeticsLive.refresh({ reason: "cosmetic_archive", keys: [String(id)] });
  res.status(200).json({ status: "success", data: publicCosmeticDisplay(doc) });
});

// ── lifecycle transitions ────────────────────────────────────────────────────

function _lifecycle(action, set) {
  return asyncHandler(async (req, res, next) => {
    const id = toObjectId(req.params.id);
    if (!id) return next(new ApiError("Invalid cosmetic id", 400));
    const before = await Cosmetic.findById(id).lean();
    if (!before) return next(new ApiError("Cosmetic not found", 404));
    const doc = await Cosmetic.findByIdAndUpdate(id, set, { new: true }).lean();
    await economyAudit.record({ req, action, entity: "cosmetic", entityId: String(id), before, after: doc, reason: req.body?.reason });
    cosmeticsLive.refresh({ reason: `cosmetic_${action}`, keys: [String(id)] });
    res.status(200).json({ status: "success", data: publicCosmeticDisplay(doc) });
  });
}

exports.adminPublishCosmetic = _lifecycle("publish", { isActive: true, status: "published" });
exports.adminDisableCosmetic = _lifecycle("disable", { isActive: false, status: "disabled" });
exports.adminArchiveCosmetic = _lifecycle("archive", { isActive: false, status: "archived" });
exports.adminRestoreCosmetic = _lifecycle("restore", { isActive: false, status: "disabled" });

// ── bulk operations ──────────────────────────────────────────────────────────

const BULK_SET = {
  publish: { isActive: true, status: "published" },
  disable: { isActive: false, status: "disabled" },
  archive: { isActive: false, status: "archived" },
  restore: { isActive: false, status: "disabled" },
};

exports.adminBulkCosmetics = asyncHandler(async (req, res, next) => {
  const { action, ids, filter, value } = req.body || {};
  let mongoFilter;
  if (Array.isArray(ids) && ids.length > 0) {
    mongoFilter = { _id: { $in: ids.map(toObjectId).filter(Boolean) } };
  } else if (filter && typeof filter === "object") {
    mongoFilter = {};
    if (filter.type) mongoFilter.type = String(filter.type);
    if (filter.category) mongoFilter.category = String(filter.category);
    if (filter.slot) mongoFilter.slot = String(filter.slot);
    if (filter.status) mongoFilter.status = String(filter.status);
  } else {
    return next(new ApiError("Bulk requires ids or filter", 400));
  }

  let set;
  if (BULK_SET[action]) set = { ...BULK_SET[action] };
  else if (action === "updatePrice") {
    if (value?.price == null) return next(new ApiError("price required", 400));
    set = { price: Math.max(0, Math.floor(Number(value.price))) };
  } else if (action === "updateCategory") {
    if (!value?.category) return next(new ApiError("category required", 400));
    set = { category: String(value.category) };
  } else {
    return next(new ApiError("Unknown bulk action", 400));
  }

  const affected = (await Cosmetic.find(mongoFilter).select("_id").lean()).map((d) => String(d._id));
  const result = await Cosmetic.updateMany(mongoFilter, { $set: set });
  await economyAudit.record({ req, action: "bulk", entity: "cosmetic", extra: { bulkAction: action, matched: result.matchedCount, modified: result.modifiedCount, ids: affected.slice(0, 200), value } });
  cosmeticsLive.refresh({ reason: `cosmetic_bulk_${action}`, keys: affected });
  res.status(200).json({ status: "success", data: { action, matched: result.matchedCount, modified: result.modifiedCount } });
});

// ── categories (store sections) ──────────────────────────────────────────────

exports.adminListCategories = asyncHandler(async (req, res) => {
  await CosmeticCategory.ensureDefaults();
  const rows = await CosmeticCategory.find({}).sort({ sortOrder: 1, key: 1 }).lean();
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminCreateCategory = asyncHandler(async (req, res, next) => {
  const key = String(req.body?.key || "").trim().toLowerCase();
  if (!key) return next(new ApiError("key is required", 400));
  if (await CosmeticCategory.findOne({ key })) return next(new ApiError("Category already exists", 409));
  const doc = await CosmeticCategory.create({
    key,
    name: req.body.name || key,
    nameAr: req.body.nameAr || null,
    icon: req.body.icon || null,
    description: req.body.description || null,
    games: parseStringArray(req.body.games) || ["all"],
    enabled: parseBool(req.body.enabled, true),
    sortOrder: Math.floor(Number(req.body.sortOrder) || 0),
  });
  await economyAudit.record({ req, action: "create", entity: "cosmetic_category", entityId: key, after: doc.toObject() });
  cosmeticsLive.refresh({ reason: "category_create", entity: "cosmetic_category", keys: [key] });
  res.status(201).json({ status: "success", data: doc });
});

exports.adminUpdateCategory = asyncHandler(async (req, res, next) => {
  const cat = await CosmeticCategory.findOne({ key: String(req.params.key) });
  if (!cat) return next(new ApiError("Category not found", 404));
  const before = cat.toObject();
  for (const f of ["name", "nameAr", "icon", "description", "enabled", "sortOrder"]) {
    if (req.body[f] !== undefined) cat[f] = f === "enabled" ? parseBool(req.body[f], true) : req.body[f];
  }
  const games = parseStringArray(req.body.games);
  if (games) cat.games = games;
  await cat.save();
  await economyAudit.record({ req, action: "update", entity: "cosmetic_category", entityId: cat.key, before, after: cat.toObject() });
  cosmeticsLive.refresh({ reason: "category_update", entity: "cosmetic_category", keys: [cat.key] });
  res.status(200).json({ status: "success", data: cat });
});

// ── equip slots ──────────────────────────────────────────────────────────────

exports.adminListSlots = asyncHandler(async (req, res) => {
  await CosmeticSlot.ensureDefaults();
  const rows = await CosmeticSlot.find({}).sort({ sortOrder: 1, key: 1 }).lean();
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminCreateSlot = asyncHandler(async (req, res, next) => {
  const key = String(req.body?.key || "").trim().toLowerCase();
  if (!key) return next(new ApiError("key is required", 400));
  if (await CosmeticSlot.findOne({ key })) return next(new ApiError("Slot already exists", 409));
  const doc = await CosmeticSlot.create({
    key,
    name: req.body.name || key,
    nameAr: req.body.nameAr || null,
    games: parseStringArray(req.body.games) || ["all"],
    legacyField: req.body.legacyField || null,
    enabled: parseBool(req.body.enabled, true),
    sortOrder: Math.floor(Number(req.body.sortOrder) || 0),
  });
  await economyAudit.record({ req, action: "create", entity: "cosmetic_slot", entityId: key, after: doc.toObject() });
  cosmeticsLive.refresh({ reason: "slot_create", entity: "cosmetic_slot", keys: [key] });
  res.status(201).json({ status: "success", data: doc });
});

exports.adminUpdateSlot = asyncHandler(async (req, res, next) => {
  const slot = await CosmeticSlot.findOne({ key: String(req.params.key) });
  if (!slot) return next(new ApiError("Slot not found", 404));
  const before = slot.toObject();
  for (const f of ["name", "nameAr", "enabled", "sortOrder"]) {
    if (req.body[f] !== undefined) slot[f] = f === "enabled" ? parseBool(req.body[f], true) : req.body[f];
  }
  const games = parseStringArray(req.body.games);
  if (games) slot.games = games;
  await slot.save();
  await economyAudit.record({ req, action: "update", entity: "cosmetic_slot", entityId: slot.key, before, after: slot.toObject() });
  cosmeticsLive.refresh({ reason: "slot_update", entity: "cosmetic_slot", keys: [slot.key] });
  res.status(200).json({ status: "success", data: slot });
});
