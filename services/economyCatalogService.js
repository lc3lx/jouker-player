"use strict";

/**
 * Economy catalog admin service — the data-driven heart of the CMS.
 *
 * Responsibilities:
 *  - Item CRUD with a soft-delete lifecycle: draft → published → disabled → archived
 *  - Lifecycle transitions (publish / disable / restore / archive / duplicate)
 *  - Bulk operations (enable/disable/archive/restore/delete + price/category/rarity)
 *  - Search / filter / sort / pagination
 *  - Permanent delete (Super Admin only — enforced at the route)
 *
 * Every mutation is a complete "admin action": it writes the change, records a
 * hash-chained audit entry, invalidates the shared catalog cache and broadcasts
 * the live `catalog_updated` signal. Coins-only; no fiat is ever introduced.
 */

const mongoose = require("mongoose");
const InteractionItem = require("../models/interactionItemModel");
const economyLive = require("./economyLive");
const economyAudit = require("./economyAuditService");

const ENTITY = "item";

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fields an admin may set on create/update (never `key`, lifecycle, or mirrors). */
const EDITABLE_FIELDS = [
  "name", "displayName", "nameAr", "arabicName", "englishName", "description",
  "category", "subCategory", "rarity", "tags",
  "icon", "thumbnail", "animation", "animationPath", "animationDuration",
  "animationScale", "animationSpeed", "sound", "impactEffect", "particleEffect", "glowEffect",
  "price", "unlimitedPrice", "perUseCost", "currencyId",
  "inventoryType", "consumable", "unlimited",
  "hidden", "featured", "recommended", "popular", "seasonal", "limitedEdition",
  "vipOnly", "vipLevel", "requiredLevel", "requiredAchievement", "requiredSeason", "requiredPackage",
  "cooldownMs", "cooldown", "dailyLimit", "matchLimit", "queueLimit",
  "bundle", "sortOrder",
];

function applyFields(doc, data) {
  for (const f of EDITABLE_FIELDS) if (data[f] !== undefined) doc[f] = data[f];
}

// ── query building (shared by list + bulk) ───────────────────────────────────

/**
 * Translate an admin query into a Mongo filter.
 * Recognized: status, category, subCategory, rarity, currencyId, featured,
 * popular, recommended, vipOnly, seasonal, requiredSeason/season, tag, q,
 * priceMin, priceMax, includeArchived.
 */
function buildFilter(q = {}) {
  const filter = {};

  if (q.status) filter.status = q.status;
  else if (!q.includeArchived) filter.status = { $ne: "archived" }; // hide soft-deleted by default

  if (q.category) filter.category = q.category;
  if (q.subCategory) filter.subCategory = q.subCategory;
  if (q.rarity) filter.rarity = q.rarity;
  if (q.currencyId) filter.currencyId = q.currencyId;
  if (q.requiredSeason || q.season) filter.requiredSeason = q.requiredSeason || q.season;

  for (const flag of ["featured", "popular", "recommended", "vipOnly", "seasonal"]) {
    if (q[flag] !== undefined && q[flag] !== "") filter[flag] = q[flag] === true || q[flag] === "true";
  }

  if (q.tag) filter.tags = q.tag;

  if (q.priceMin != null || q.priceMax != null) {
    filter.price = {};
    if (q.priceMin != null && q.priceMin !== "") filter.price.$gte = Number(q.priceMin);
    if (q.priceMax != null && q.priceMax !== "") filter.price.$lte = Number(q.priceMax);
    if (Object.keys(filter.price).length === 0) delete filter.price;
  }

  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), "i");
    filter.$or = [
      { key: rx }, { name: rx }, { displayName: rx },
      { englishName: rx }, { arabicName: rx }, { nameAr: rx }, { tags: rx },
    ];
  }
  return filter;
}

const SORTABLE = new Set(["sortOrder", "price", "createdAt", "updatedAt", "name", "rarity", "category"]);

function buildSort(q = {}) {
  const field = SORTABLE.has(q.sortBy) ? q.sortBy : "sortOrder";
  const dir = String(q.sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;
  const sort = { [field]: dir };
  if (field !== "createdAt") sort.createdAt = -1; // stable tiebreaker
  return sort;
}

// ── read ─────────────────────────────────────────────────────────────────────

async function list(q = {}) {
  await InteractionItem.ensureDefaults();
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || "25", 10)));
  const filter = buildFilter(q);
  const sort = buildSort(q);

  const [total, rows] = await Promise.all([
    InteractionItem.countDocuments(filter),
    InteractionItem.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return { page, limit, total, pages: Math.ceil(total / limit), rows };
}

/** Fetch by Mongo _id or by stable `key`. */
async function get(idOrKey) {
  const s = String(idOrKey);
  if (mongoose.isValidObjectId(s)) {
    const byId = await InteractionItem.findById(s).lean();
    if (byId) return byId;
  }
  return InteractionItem.findOne({ key: s }).lean();
}

async function _load(idOrKey) {
  const s = String(idOrKey);
  if (mongoose.isValidObjectId(s)) {
    const byId = await InteractionItem.findById(s);
    if (byId) return byId;
  }
  return InteractionItem.findOne({ key: s });
}

// ── create / update ──────────────────────────────────────────────────────────

async function create(data = {}, ctx = {}) {
  const key = String(data.key || "").trim();
  if (!key) throw new Error("KEY_REQUIRED");
  if (!data.name) throw new Error("NAME_REQUIRED");
  if (!data.icon) throw new Error("ICON_REQUIRED");
  if (!data.animation) throw new Error("ANIMATION_REQUIRED");
  if (!data.category) throw new Error("CATEGORY_REQUIRED");
  if (data.price == null || Number(data.price) < 0) throw new Error("PRICE_REQUIRED");
  if (await InteractionItem.findOne({ key })) throw new Error("KEY_EXISTS");

  const doc = new InteractionItem({ key });
  applyFields(doc, data);
  if (!doc.currencyId) doc.currencyId = "coins";
  // New items start as DRAFT unless the admin explicitly publishes on create.
  doc.status = data.status === "published" ? "published" : "draft";
  await doc.save();

  await economyAudit.record({ ...ctx, action: "create", entity: ENTITY, entityId: doc.key, after: doc.toObject() });
  economyLive.refresh({ reason: "item_create", entity: ENTITY, keys: [doc.key] });
  return doc.toObject();
}

async function update(idOrKey, patch = {}, ctx = {}) {
  const doc = await _load(idOrKey);
  if (!doc) throw new Error("NOT_FOUND");
  const before = doc.toObject();
  applyFields(doc, patch); // status/enabled/key deliberately excluded
  await doc.save();

  await economyAudit.record({ ...ctx, action: "update", entity: ENTITY, entityId: doc.key, before, after: doc.toObject(), reason: ctx.reason });
  economyLive.refresh({ reason: "item_update", entity: ENTITY, keys: [doc.key] });
  return { before, after: doc.toObject() };
}

// ── lifecycle transitions ─────────────────────────────────────────────────────

async function _transition(idOrKey, action, mutate, ctx = {}) {
  const doc = await _load(idOrKey);
  if (!doc) throw new Error("NOT_FOUND");
  const before = doc.toObject();
  mutate(doc);
  await doc.save();

  await economyAudit.record({ ...ctx, action, entity: ENTITY, entityId: doc.key, before, after: doc.toObject(), reason: ctx.reason });
  economyLive.refresh({ reason: `item_${action}`, entity: ENTITY, keys: [doc.key] });
  return { before, after: doc.toObject() };
}

const publish = (idOrKey, ctx) => _transition(idOrKey, "publish", (d) => { d.status = "published"; d.deletedAt = null; }, ctx);
const disable = (idOrKey, ctx) => _transition(idOrKey, "disable", (d) => { d.status = "disabled"; }, ctx);
const archive = (idOrKey, ctx) => _transition(idOrKey, "archive", (d) => { d.status = "archived"; d.deletedAt = new Date(); }, ctx);
/** Restore recovers an archived/disabled item to a hidden "disabled" state (admin re-publishes explicitly). */
const restore = (idOrKey, ctx) => _transition(idOrKey, "restore", (d) => { d.status = "disabled"; d.deletedAt = null; }, ctx);

async function duplicate(idOrKey, ctx = {}) {
  const src = await get(idOrKey);
  if (!src) throw new Error("NOT_FOUND");

  // Generate a unique key: <key>_copy, _copy2, _copy3, …
  let newKey = `${src.key}_copy`;
  for (let n = 2; await InteractionItem.exists({ key: newKey }); n++) newKey = `${src.key}_copy${n}`;

  const doc = new InteractionItem({ key: newKey });
  applyFields(doc, src);
  doc.name = `${src.name} (Copy)`;
  doc.status = "draft";
  doc.deletedAt = null;
  await doc.save();

  await economyAudit.record({ ...ctx, action: "duplicate", entity: ENTITY, entityId: doc.key, after: doc.toObject(), extra: { sourceKey: src.key } });
  economyLive.refresh({ reason: "item_duplicate", entity: ENTITY, keys: [doc.key] });
  return doc.toObject();
}

/** Hard delete — Super Admin only (permission enforced at the route). */
async function permanentDelete(idOrKey, ctx = {}) {
  const doc = await _load(idOrKey);
  if (!doc) throw new Error("NOT_FOUND");
  const before = doc.toObject();
  await doc.deleteOne();

  await economyAudit.record({ ...ctx, action: "permanent_delete", entity: ENTITY, entityId: before.key, before, reason: ctx.reason });
  economyLive.refresh({ reason: "item_permanent_delete", entity: ENTITY, keys: [before.key] });
  return { before };
}

// ── bulk operations ───────────────────────────────────────────────────────────

/** Resolve the target set for a bulk op from explicit keys or a filter. */
function _bulkFilter({ keys, filter } = {}) {
  if (Array.isArray(keys) && keys.length > 0) return { key: { $in: keys.map(String) } };
  if (filter && typeof filter === "object") return buildFilter(filter);
  throw new Error("NO_TARGETS"); // never allow an unscoped bulk mutation
}

const BULK_STATUS = {
  enable: { status: "published" },
  disable: { status: "disabled" },
  archive: { status: "archived" },
  restore: { status: "disabled" },
  delete: { status: "archived" }, // "delete many" is a soft archive; permanent delete is single + super-admin
};

/**
 * @param {object} p
 * @param {string} p.action  enable|disable|archive|restore|delete|updatePrice|updateCategory|updateRarity
 * @param {string[]} [p.keys]
 * @param {object} [p.filter]
 * @param {object} [p.value] payload for update* actions
 */
async function bulk({ action, keys, filter, value = {} }, ctx = {}) {
  const mongoFilter = _bulkFilter({ keys, filter });
  let set = null;

  if (BULK_STATUS[action]) {
    set = { ...BULK_STATUS[action] };
    set.enabled = set.status === "published";
    if (set.status === "archived") set.deletedAt = new Date();
    if (set.status !== "archived") set.deletedAt = null;
  } else if (action === "updatePrice") {
    set = {};
    for (const f of ["price", "unlimitedPrice", "perUseCost"]) {
      if (value[f] !== undefined) set[f] = Math.max(0, Number(value[f]));
    }
    if (Object.keys(set).length === 0) throw new Error("NO_PRICE_FIELDS");
  } else if (action === "updateCategory") {
    if (!value.category) throw new Error("CATEGORY_REQUIRED");
    set = { category: String(value.category) };
  } else if (action === "updateRarity") {
    if (!value.rarity) throw new Error("RARITY_REQUIRED");
    set = { rarity: String(value.rarity) };
  } else {
    throw new Error("UNKNOWN_BULK_ACTION");
  }

  const matched = await InteractionItem.countDocuments(mongoFilter);
  const affectedKeys = (await InteractionItem.find(mongoFilter).select("key").lean()).map((d) => d.key);
  const res = await InteractionItem.updateMany(mongoFilter, { $set: set });

  await economyAudit.record({
    ...ctx, action: "bulk", entity: ENTITY,
    reason: ctx.reason,
    extra: { bulkAction: action, matched, modified: res.modifiedCount, keys: affectedKeys.slice(0, 200), value },
  });
  economyLive.refresh({ reason: `bulk_${action}`, entity: ENTITY, keys: affectedKeys });
  return { action, matched, modified: res.modifiedCount, keys: affectedKeys };
}

module.exports = {
  buildFilter,
  list, get,
  create, update,
  publish, disable, archive, restore, duplicate,
  permanentDelete,
  bulk,
  EDITABLE_FIELDS,
};
