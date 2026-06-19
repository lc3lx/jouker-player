const path = require("path");
const fs = require("fs");
const asyncHandler = require("express-async-handler");
const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const mongoose = require("mongoose");

const ApiError = require("../utils/apiError");
const Cosmetic = require("../models/cosmeticModel");
const { uploadSingleImage } = require("../middlewares/uploadImageMiddleware");
const { publicCosmeticDisplay } = require("./cosmeticsService");

const COSMETIC_TYPES = new Set(["table_theme", "card_skin", "avatar_frame", "bundle"]);
const RARITIES = new Set(["common", "rare", "epic"]);

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

function buildCosmeticBody(req, { partial = false } = {}) {
  const body = {};
  const setIfPresent = (key, transform = (v) => v) => {
    if (partial && typeof req.body[key] === "undefined") return;
    if (typeof req.body[key] !== "undefined") body[key] = transform(req.body[key]);
  };

  setIfPresent("name", (v) => String(v || "").trim());
  setIfPresent("type", (v) => String(v || "").trim());
  setIfPresent("assetKey", assertAssetKey);
  setIfPresent("price", (v) => Math.max(0, Math.floor(Number(v) || 0)));
  setIfPresent("rarity", (v) => String(v || "common").trim());
  setIfPresent("isActive", (v) => parseBool(v, true));
  setIfPresent("featured", (v) => parseBool(v, false));
  setIfPresent("featuredOrder", (v) => Math.floor(Number(v) || 0));

  if (!partial || typeof req.body.promoMeta !== "undefined") {
    const meta = parsePromoMeta(req.body.promoMeta);
    if (meta !== undefined) body.promoMeta = meta;
  }

  if (req.file) {
    body.previewImage = req.body.previewImage;
  } else if (!partial && req.body.previewImage) {
    body.previewImage = String(req.body.previewImage).trim();
  }

  if (body.type && !COSMETIC_TYPES.has(body.type)) {
    throw new ApiError("Invalid cosmetic type", 400);
  }
  if (body.rarity && !RARITIES.has(body.rarity)) {
    throw new ApiError("Invalid rarity", 400);
  }

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
  const filter = {};
  if (req.query.type && COSMETIC_TYPES.has(String(req.query.type))) {
    filter.type = String(req.query.type);
  }
  if (req.query.isActive === "true") filter.isActive = true;
  if (req.query.isActive === "false") filter.isActive = false;

  const rows = await Cosmetic.find(filter)
    .sort({ type: 1, featuredOrder: 1, name: 1 })
    .lean();

  const data = rows.map(publicCosmeticDisplay).filter(Boolean);
  res.status(200).json({ status: "success", results: data.length, data });
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

  const doc = await Cosmetic.findByIdAndUpdate(id, body, { new: true, runValidators: true }).lean();
  if (!doc) return next(new ApiError("Cosmetic not found", 404));
  res.status(200).json({ status: "success", data: publicCosmeticDisplay(doc) });
});

exports.adminDeleteCosmetic = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  if (!id) return next(new ApiError("Invalid cosmetic id", 400));

  const doc = await Cosmetic.findByIdAndUpdate(id, { isActive: false }, { new: true }).lean();
  if (!doc) return next(new ApiError("Cosmetic not found", 404));
  res.status(200).json({ status: "success", data: publicCosmeticDisplay(doc) });
});
