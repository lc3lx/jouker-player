"use strict";

/**
 * Interaction category CRUD. Categories are a managed, UNLIMITED set — the
 * catalog stores `category` as a free string, so adding a category here never
 * requires a schema or code change.
 */

const InteractionCategory = require("../models/interactionCategoryModel");
const economyLive = require("./economyLive");

async function ensureSeed() {
  await InteractionCategory.ensureDefaults();
}

async function list({ includeDisabled = true } = {}) {
  await ensureSeed();
  const filter = includeDisabled ? {} : { enabled: true };
  return InteractionCategory.find(filter).sort({ sortOrder: 1, key: 1 }).lean();
}

async function get(key) {
  return InteractionCategory.findOne({ key: String(key) }).lean();
}

async function create(data = {}) {
  const key = String(data.key || "").trim().toLowerCase();
  if (!key) throw new Error("KEY_REQUIRED");
  if (await InteractionCategory.findOne({ key })) throw new Error("KEY_EXISTS");
  const doc = await InteractionCategory.create({
    key,
    name: data.name || key,
    nameAr: data.nameAr || null,
    icon: data.icon || null,
    description: data.description || null,
    enabled: data.enabled !== false,
    sortOrder: Number(data.sortOrder) || 0,
  });
  economyLive.refresh({ reason: "category_create", entity: "category", keys: [key] });
  return doc.toObject();
}

async function update(key, patch = {}) {
  const cat = await InteractionCategory.findOne({ key: String(key) });
  if (!cat) throw new Error("NOT_FOUND");
  const before = cat.toObject();
  const fields = ["name", "nameAr", "icon", "description", "enabled", "sortOrder"];
  for (const f of fields) if (patch[f] !== undefined) cat[f] = patch[f];
  await cat.save();
  economyLive.refresh({ reason: "category_update", entity: "category", keys: [cat.key] });
  return { before, after: cat.toObject() };
}

module.exports = { ensureSeed, list, get, create, update };
