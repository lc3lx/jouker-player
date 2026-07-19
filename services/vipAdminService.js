"use strict";

/**
 * VIP CMS admin service — unlimited VIP levels + admin-managed cosmetic rewards.
 * Every mutation reloads the in-memory sync registries (so seat/benefit resolution
 * reflects the change immediately), pushes a live `vip_updated` signal, and writes
 * a hash-chained audit entry. VIP stays real-money (USD); no coin-buyable VIP.
 */

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const VipLevel = require("../models/vipLevelModel");
const VipReward = require("../models/vipRewardModel");
const Cosmetic = require("../models/cosmeticModel");
const vipLive = require("./vipLive");
const economyAudit = require("./economyAuditService");
const mongoose = require("mongoose");

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; }
}

const LEVEL_FIELDS = [
  "name", "nameAr", "description", "priority", "badge", "color", "icon",
  "background", "preview", "priceUsd", "priceCents", "currency", "durationDays",
  "freeTrialDays", "autoRenewDefault", "promo", "enabled", "sortOrder",
];
const BENEFIT_FIELDS = ["cashbackPercent", "weeklyCashbackCapChips", "dailyChips", "quiz", "priorityQueue", "queueBoostMs"];

function applyLevelBody(doc, body) {
  for (const f of LEVEL_FIELDS) if (body[f] !== undefined) doc[f] = body[f];
  if (body.benefits && typeof body.benefits === "object") {
    doc.benefits = doc.benefits || {};
    for (const f of BENEFIT_FIELDS) if (body.benefits[f] !== undefined) doc.benefits[f] = body.benefits[f];
  }
}

// ── VIP levels ───────────────────────────────────────────────────────────────

exports.adminListLevels = asyncHandler(async (req, res) => {
  await VipLevel.ensureDefaults();
  const rows = await VipLevel.find({}).sort({ priority: 1, sortOrder: 1 }).lean();
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminCreateLevel = asyncHandler(async (req, res, next) => {
  const key = String(req.body?.key || "").trim().toLowerCase();
  if (!key) return next(new ApiError("key is required", 400));
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) return next(new ApiError("Invalid level key", 400));
  if (await VipLevel.findOne({ key })) return next(new ApiError("VIP level already exists", 409));

  const doc = new VipLevel({ key, name: req.body.name || key, priority: Number(req.body.priority) || 1 });
  applyLevelBody(doc, req.body);
  await doc.save();
  await economyAudit.record({ req, action: "create", entity: "vip_level", entityId: key, after: doc.toObject() });
  await vipLive.refresh({ reason: "vip_level_create", keys: [key] });
  res.status(201).json({ status: "success", data: doc.toObject() });
});

exports.adminUpdateLevel = asyncHandler(async (req, res, next) => {
  const doc = await VipLevel.findOne({ key: String(req.params.key) });
  if (!doc) return next(new ApiError("VIP level not found", 404));
  const before = doc.toObject();
  applyLevelBody(doc, req.body || {});
  await doc.save();
  await economyAudit.record({ req, action: "update", entity: "vip_level", entityId: doc.key, before, after: doc.toObject(), reason: req.body?.reason });
  await vipLive.refresh({ reason: "vip_level_update", keys: [doc.key] });
  res.status(200).json({ status: "success", data: doc.toObject() });
});

/** Soft delete — disable (subscriptions reference the key; never hard-remove). */
exports.adminDeleteLevel = asyncHandler(async (req, res, next) => {
  const doc = await VipLevel.findOne({ key: String(req.params.key) });
  if (!doc) return next(new ApiError("VIP level not found", 404));
  const before = doc.toObject();
  doc.enabled = false;
  await doc.save();
  await economyAudit.record({ req, action: "disable", entity: "vip_level", entityId: doc.key, before, after: doc.toObject() });
  await vipLive.refresh({ reason: "vip_level_disable", keys: [doc.key] });
  res.status(200).json({ status: "success", data: doc.toObject() });
});

// ── VIP rewards (level → cosmetic) ───────────────────────────────────────────

exports.adminListRewards = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.vipLevelKey) filter.vipLevelKey = String(req.query.vipLevelKey);
  const rows = await VipReward.find(filter)
    .sort({ vipLevelKey: 1, sortOrder: 1 })
    .populate("cosmeticId", "name type slot assetKey renderType previewImage isActive")
    .lean();
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminCreateReward = asyncHandler(async (req, res, next) => {
  const vipLevelKey = String(req.body?.vipLevelKey || "").trim().toLowerCase();
  const cosmeticId = toObjectId(req.body?.cosmeticId);
  if (!vipLevelKey || !cosmeticId) return next(new ApiError("vipLevelKey and cosmeticId are required", 400));
  const level = await VipLevel.findOne({ key: vipLevelKey }).lean();
  if (!level) return next(new ApiError("VIP level not found", 404));
  const cosmetic = await Cosmetic.findById(cosmeticId).lean();
  if (!cosmetic) return next(new ApiError("Cosmetic not found", 404));

  let doc;
  try {
    doc = await VipReward.create({
      vipLevelKey,
      cosmeticId,
      gameKey: req.body.gameKey || null,
      autoEquip: req.body.autoEquip === true || req.body.autoEquip === "true",
      enabled: req.body.enabled !== false && req.body.enabled !== "false",
      sortOrder: Math.floor(Number(req.body.sortOrder) || 0),
    });
  } catch (e) {
    if (e?.code === 11000) return next(new ApiError("This reward already exists for the level", 409));
    throw e;
  }
  await economyAudit.record({ req, action: "create", entity: "vip_reward", entityId: String(doc._id), after: doc.toObject(), extra: { vipLevelKey, cosmeticId: String(cosmeticId) } });
  await vipLive.refresh({ reason: "vip_reward_create", rewards: true, keys: [vipLevelKey] });
  res.status(201).json({ status: "success", data: doc.toObject() });
});

exports.adminUpdateReward = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  const doc = id ? await VipReward.findById(id) : null;
  if (!doc) return next(new ApiError("Reward not found", 404));
  const before = doc.toObject();
  for (const f of ["gameKey", "autoEquip", "enabled", "sortOrder"]) {
    if (req.body[f] !== undefined) doc[f] = req.body[f];
  }
  await doc.save();
  await economyAudit.record({ req, action: "update", entity: "vip_reward", entityId: String(doc._id), before, after: doc.toObject() });
  await vipLive.refresh({ reason: "vip_reward_update", rewards: true, keys: [doc.vipLevelKey] });
  res.status(200).json({ status: "success", data: doc.toObject() });
});

exports.adminDeleteReward = asyncHandler(async (req, res, next) => {
  const id = toObjectId(req.params.id);
  const doc = id ? await VipReward.findByIdAndDelete(id) : null;
  if (!doc) return next(new ApiError("Reward not found", 404));
  await economyAudit.record({ req, action: "delete", entity: "vip_reward", entityId: String(id), before: doc.toObject() });
  await vipLive.refresh({ reason: "vip_reward_delete", rewards: true, keys: [doc.vipLevelKey] });
  res.status(200).json({ status: "success", data: { id: String(id) } });
});
