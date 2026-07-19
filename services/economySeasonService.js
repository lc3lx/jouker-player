"use strict";

/**
 * Economy season CRUD + activation. Items reference a season via
 * `item.requiredSeason` (= EconomySeason.key). A season being "live" gates
 * seasonal item availability and event-scoped discounts.
 */

const EconomySeason = require("../models/economySeasonModel");
const economyLive = require("./economyLive");

async function list({ includeInactive = true } = {}) {
  const filter = includeInactive ? {} : { active: true };
  return EconomySeason.find(filter).sort({ sortOrder: 1, startDate: -1 }).lean();
}

async function get(key) {
  return EconomySeason.findOne({ key: String(key) }).lean();
}

/** Keys of every season that is currently live (active + inside date window). */
async function liveSeasonKeys(at = Date.now()) {
  const seasons = await EconomySeason.find({ active: true }).lean();
  return seasons
    .filter((s) => {
      const t = at instanceof Date ? at.getTime() : at;
      if (s.startDate && t < new Date(s.startDate).getTime()) return false;
      if (s.endDate && t > new Date(s.endDate).getTime()) return false;
      return true;
    })
    .map((s) => s.key);
}

async function create(data = {}) {
  const key = String(data.key || "").trim().toLowerCase();
  if (!key) throw new Error("KEY_REQUIRED");
  if (await EconomySeason.findOne({ key })) throw new Error("KEY_EXISTS");
  const doc = await EconomySeason.create({
    key,
    name: data.name || key,
    nameAr: data.nameAr || null,
    description: data.description || null,
    icon: data.icon || null,
    startDate: data.startDate ? new Date(data.startDate) : null,
    endDate: data.endDate ? new Date(data.endDate) : null,
    active: data.active === true,
    sortOrder: Number(data.sortOrder) || 0,
  });
  economyLive.refresh({ reason: "season_create", entity: "season", keys: [key] });
  return doc.toObject();
}

async function update(key, patch = {}) {
  const s = await EconomySeason.findOne({ key: String(key) });
  if (!s) throw new Error("NOT_FOUND");
  const before = s.toObject();
  const fields = ["name", "nameAr", "description", "icon", "active", "sortOrder"];
  for (const f of fields) if (patch[f] !== undefined) s[f] = patch[f];
  if (patch.startDate !== undefined) s.startDate = patch.startDate ? new Date(patch.startDate) : null;
  if (patch.endDate !== undefined) s.endDate = patch.endDate ? new Date(patch.endDate) : null;
  await s.save();
  economyLive.refresh({ reason: "season_update", entity: "season", keys: [s.key] });
  return { before, after: s.toObject() };
}

async function setActive(key, active) {
  return update(key, { active: !!active });
}

module.exports = { list, get, create, update, setActive, liveSeasonKeys };
