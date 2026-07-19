"use strict";

/**
 * Discounts & flash sales. A flash sale is a discount with a tight date window
 * and `flashSale:true`. Discounts only ever reduce Coin prices — no fiat.
 *
 * `resolveEffectivePrice` computes the best active discount for an item, honoring
 * VIP-only and event(season)-scoped discounts, with a per-discount price floor.
 * The catalog/purchase path uses this so shop prices and charges always agree.
 */

const EconomyDiscount = require("../models/economyDiscountModel");
const economyLive = require("./economyLive");

// Short cache — discounts change far less often than they're read.
let _cache = null;
let _cacheAt = 0;
const TTL_MS = 15_000;

async function _activeDiscounts() {
  const now = Date.now();
  if (_cache && now - _cacheAt < TTL_MS) return _cache;
  const rows = await EconomyDiscount.find({ active: true }).lean();
  _cache = rows.filter((d) => {
    if (d.startDate && now < new Date(d.startDate).getTime()) return false;
    if (d.endDate && now > new Date(d.endDate).getTime()) return false;
    return true;
  });
  _cacheAt = now;
  return _cache;
}

function _invalidate() {
  _cache = null;
  _cacheAt = 0;
}

function _matchesItem(discount, item) {
  switch (discount.appliesTo) {
    case "all": return true;
    case "items": return discount.targets.includes(item.key);
    case "categories": return discount.targets.includes(item.category);
    case "rarities": return discount.targets.includes(item.rarity);
    default: return false;
  }
}

function _apply(discount, basePrice) {
  let price = discount.type === "percentage"
    ? Math.round(basePrice * (1 - Math.min(100, Math.max(0, discount.value)) / 100))
    : Math.max(0, basePrice - discount.value);
  price = Math.max(price, discount.minPrice || 0);
  return Math.max(0, price);
}

/**
 * Best effective price for `item`.
 * @param {object} item                    catalog item (needs key/category/rarity/price)
 * @param {{ isVip?: boolean, liveSeasonKeys?: string[], basePriceField?: string }} [ctx]
 * @returns {Promise<{ price, basePrice, discount: null|{id,name,type,value,flashSale} }>}
 */
async function resolveEffectivePrice(item, ctx = {}) {
  const field = ctx.basePriceField || "price";
  const basePrice = Number(item[field] || 0);
  const discounts = await _activeDiscounts();
  const liveSeasons = ctx.liveSeasonKeys || null;

  let best = null;
  let bestPrice = basePrice;
  for (const d of discounts) {
    if (d.vipOnly && !ctx.isVip) continue;
    if (d.eventSeasonKey) {
      if (!liveSeasons || !liveSeasons.includes(d.eventSeasonKey)) continue;
    }
    if (!_matchesItem(d, item)) continue;
    const candidate = _apply(d, basePrice);
    // Best = lowest price; ties broken by higher priority.
    if (candidate < bestPrice || (candidate === bestPrice && best && (d.priority || 0) > (best.priority || 0))) {
      bestPrice = candidate;
      best = d;
    }
  }

  return {
    price: bestPrice,
    basePrice,
    discount: best
      ? { id: String(best._id), name: best.name, type: best.type, value: best.value, flashSale: !!best.flashSale }
      : null,
  };
}

// ── admin CRUD ─────────────────────────────────────────────────────────────

async function list({ includeInactive = true } = {}) {
  const filter = includeInactive ? {} : { active: true };
  return EconomyDiscount.find(filter).sort({ priority: -1, createdAt: -1 }).lean();
}

async function get(id) {
  return EconomyDiscount.findById(id).lean();
}

const EDITABLE = [
  "name", "nameAr", "type", "value", "appliesTo", "targets",
  "active", "flashSale", "vipOnly", "eventSeasonKey", "minPrice", "priority",
];

async function create(data = {}) {
  if (!data.type || !["percentage", "fixed"].includes(data.type)) throw new Error("INVALID_TYPE");
  const doc = await EconomyDiscount.create({
    name: data.name || "Discount",
    nameAr: data.nameAr || null,
    type: data.type,
    value: Math.max(0, Number(data.value) || 0),
    appliesTo: data.appliesTo || "items",
    targets: Array.isArray(data.targets) ? data.targets.map(String) : [],
    startDate: data.startDate ? new Date(data.startDate) : null,
    endDate: data.endDate ? new Date(data.endDate) : null,
    active: data.active !== false,
    flashSale: data.flashSale === true,
    vipOnly: data.vipOnly === true,
    eventSeasonKey: data.eventSeasonKey || null,
    minPrice: Math.max(0, Number(data.minPrice) || 0),
    priority: Number(data.priority) || 0,
  });
  _invalidate();
  economyLive.refresh({ reason: "discount_create", entity: "discount", keys: [String(doc._id)] });
  return doc.toObject();
}

async function update(id, patch = {}) {
  const d = await EconomyDiscount.findById(id);
  if (!d) throw new Error("NOT_FOUND");
  const before = d.toObject();
  for (const f of EDITABLE) if (patch[f] !== undefined) d[f] = patch[f];
  if (patch.startDate !== undefined) d.startDate = patch.startDate ? new Date(patch.startDate) : null;
  if (patch.endDate !== undefined) d.endDate = patch.endDate ? new Date(patch.endDate) : null;
  await d.save();
  _invalidate();
  economyLive.refresh({ reason: "discount_update", entity: "discount", keys: [String(d._id)] });
  return { before, after: d.toObject() };
}

async function remove(id) {
  const d = await EconomyDiscount.findByIdAndDelete(id);
  if (!d) throw new Error("NOT_FOUND");
  _invalidate();
  economyLive.refresh({ reason: "discount_delete", entity: "discount", keys: [String(id)] });
  return { before: d.toObject() };
}

async function setActive(id, active) {
  return update(id, { active: !!active });
}

module.exports = {
  resolveEffectivePrice,
  list, get, create, update, remove, setActive,
  _invalidate,
};
