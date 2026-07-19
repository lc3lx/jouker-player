"use strict";

/**
 * In-memory VIP level registry — the sync compatibility layer that lets
 * config/vipConfig.js keep its exact synchronous API while the actual levels
 * live in the DB (VipLevel collection).
 *
 * - Seeded at load from the built-in 4 defaults, so every sync caller (incl. the
 *   `peekVipLevelSync` game-state hot path) works before the DB is reachable.
 * - `refresh()` reloads from the DB (defaults first, DB overrides/adds on top) so
 *   a DB hiccup can never drop the 4 legacy levels.
 * - First sync access warms the cache in the background (fire-and-forget), like
 *   the existing vipLevelCache pattern.
 */

const logger = require("../utils/logger");

let _byKey = _seedDefaults();
let _warm = false;
let _refreshing = false;

function _flattenDefault(key, c) {
  return {
    level: key,
    rank: c.rank,
    priceUsd: c.priceUsd,
    priceCents: c.priceCents,
    cashbackPercent: c.cashbackPercent,
    weeklyCashbackCapChips: c.weeklyCashbackCapChips,
    dailyChips: c.dailyChips,
    quiz: c.quiz,
    priorityQueue: c.priorityQueue,
    queueBoostMs: c.queueBoostMs,
    durationDays: 30,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    enabled: true,
  };
}

function _seedDefaults() {
  const { VIP_LEVELS, VIP_LEVEL_CONFIG } = require("../config/vipConfig");
  const map = new Map();
  for (const key of VIP_LEVELS) map.set(key, _flattenDefault(key, VIP_LEVEL_CONFIG[key]));
  return map;
}

function _ensureWarm() {
  if (_warm || _refreshing) return;
  _refreshing = true;
  refresh()
    .catch((e) => logger.warn("vip_level_registry_warm_failed", { reason: e?.message || "unknown" }))
    .finally(() => { _refreshing = false; });
}

/** Reload the registry from the DB. Defaults first so DB errors never lose the 4. */
async function refresh() {
  const VipLevel = require("../models/vipLevelModel");
  await VipLevel.ensureDefaults();
  const rows = await VipLevel.find({}).lean();
  const map = _seedDefaults();
  for (const r of rows) {
    map.set(r.key, {
      level: r.key,
      rank: Number(r.priority) || 0,
      priceUsd: Number(r.priceUsd) || 0,
      priceCents: Number(r.priceCents) || 0,
      cashbackPercent: r.benefits?.cashbackPercent || 0,
      weeklyCashbackCapChips: r.benefits?.weeklyCashbackCapChips || 0,
      dailyChips: r.benefits?.dailyChips || 0,
      quiz: !!r.benefits?.quiz,
      priorityQueue: !!r.benefits?.priorityQueue,
      queueBoostMs: r.benefits?.queueBoostMs || 0,
      durationDays: r.durationDays || 30,
      name: r.name,
      nameAr: r.nameAr,
      badge: r.badge,
      color: r.color,
      icon: r.icon,
      background: r.background,
      preview: r.preview,
      enabled: r.enabled !== false,
    });
  }
  _byKey = map;
  _warm = true;
  return map;
}

function _norm(key) {
  return String(key || "").toLowerCase().trim();
}

function config(key) {
  _ensureWarm();
  return _byKey.get(_norm(key)) || null;
}

function isValid(key) {
  return !!config(key);
}

function rank(key) {
  const c = config(key);
  return c ? c.rank : 0;
}

function maxRank() {
  let m = 0;
  for (const c of _byKey.values()) if (c.enabled !== false && c.rank > m) m = c.rank;
  return m;
}

/** Enabled level keys ordered by rank ascending (matches legacy VIP_LEVELS order). */
function levels() {
  _ensureWarm();
  return [..._byKey.entries()]
    .filter(([, c]) => c.enabled !== false)
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([k]) => k);
}

function allConfigs() {
  _ensureWarm();
  return [..._byKey.values()].filter((c) => c.enabled !== false).sort((a, b) => a.rank - b.rank);
}

function publicBenefits(key) {
  const c = config(key);
  if (!c) return null;
  return {
    level: c.level,
    rank: c.rank,
    priceUsd: c.priceUsd,
    cashbackPercent: c.cashbackPercent,
    weeklyCashbackCapChips: c.weeklyCashbackCapChips,
    dailyChips: c.dailyChips,
    quiz: c.quiz,
    priorityQueue: c.priorityQueue,
    highestPriority: c.rank === maxRank(),
  };
}

/** Test helper: reset to defaults + force a re-warm. */
function _resetForTests() {
  _byKey = _seedDefaults();
  _warm = false;
  _refreshing = false;
}

module.exports = {
  refresh,
  config,
  isValid,
  rank,
  maxRank,
  levels,
  allConfigs,
  publicBenefits,
  _resetForTests,
};
