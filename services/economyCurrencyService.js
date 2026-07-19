"use strict";

/**
 * Currency CRUD for the Admin CMS. The platform is Coins-ONLY (virtual) today;
 * this exists so future virtual currencies can be added from the dashboard with
 * zero code changes. No fiat / payment gateways are ever introduced here.
 */

const Currency = require("../models/currencyModel");
const economyLive = require("./economyLive");

async function ensureSeed() {
  await Currency.ensureDefaults();
}

async function list({ includeDisabled = true } = {}) {
  await ensureSeed();
  const filter = includeDisabled ? {} : { enabled: true };
  return Currency.find(filter).sort({ sortOrder: 1, code: 1 }).lean();
}

async function get(code) {
  return Currency.findOne({ code: String(code) }).lean();
}

async function create(data = {}) {
  const code = String(data.code || "").trim().toLowerCase();
  if (!code) throw new Error("CODE_REQUIRED");
  const exists = await Currency.findOne({ code });
  if (exists) throw new Error("CODE_EXISTS");
  const doc = await Currency.create({
    code,
    name: data.name || code,
    nameAr: data.nameAr || null,
    symbol: data.symbol || null,
    icon: data.icon || null,
    enabled: data.enabled !== false,
    isDefault: false, // default currency is fixed to seeded coins
    sortOrder: Number(data.sortOrder) || 0,
  });
  economyLive.refresh({ reason: "currency_create", entity: "currency", keys: [code] });
  return doc.toObject();
}

async function update(code, patch = {}) {
  const cur = await Currency.findOne({ code: String(code) });
  if (!cur) throw new Error("NOT_FOUND");
  const before = cur.toObject();
  const fields = ["name", "nameAr", "symbol", "icon", "enabled", "sortOrder"];
  for (const f of fields) if (patch[f] !== undefined) cur[f] = patch[f];
  // The default currency can never be disabled (wallet balance depends on it).
  if (cur.isDefault) cur.enabled = true;
  await cur.save();
  economyLive.refresh({ reason: "currency_update", entity: "currency", keys: [cur.code] });
  return { before, after: cur.toObject() };
}

/** Currencies are never hard-deleted from CMS by default — disable instead. */
async function setEnabled(code, enabled) {
  return update(code, { enabled: !!enabled });
}

module.exports = { ensureSeed, list, get, create, update, setEnabled };
