"use strict";

/**
 * Deep game-statistics collection framework. Games call `record()` / `setGauge()`
 * to accumulate any metric; the profile endpoint surfaces them via `getForUser()`.
 * Adding a new game or metric requires NO code change here — the metric registry
 * only supplies OPTIONAL display labels/order/format for the client; unknown
 * metrics still flow through and render with their raw key.
 *
 * Instrumentation call sites (poker settlement, trix/tarneeb round end) can adopt
 * these fire-and-forget helpers incrementally without touching this service.
 */

const PlayerGameStats = require("../models/playerGameStatsModel");
const logger = require("../utils/logger");

/**
 * Optional presentation metadata per game. Games/metrics NOT listed here still
 * work — this only drives labels/order/derived-metric hints on the client.
 * `derived` metrics are computed from raw counters at read time.
 */
const METRIC_REGISTRY = {
  poker: {
    label: "بوكر تكساس",
    order: ["handsPlayed", "handsWon", "showdowns", "showdownsWon", "allIns", "biggestPot", "avgPot", "foldPct", "vpip", "pfr"],
    labels: {
      handsPlayed: "أيدي لعبت", handsWon: "أيدي فائزة", showdowns: "مواجهات",
      showdownsWon: "مواجهات مكسوبة", allIns: "All-in", biggestPot: "أكبر بوت",
      avgPot: "متوسط البوت", foldPct: "نسبة الطي %", vpip: "VPIP %", pfr: "PFR %", winStreak: "سلسلة فوز",
    },
    percentMetrics: ["foldPct", "vpip", "pfr"],
  },
  trix: {
    label: "تركس",
    order: ["games", "wins", "avgScore"],
    labels: { games: "مباريات", wins: "انتصارات", avgScore: "متوسط النقاط" },
  },
  tarneeb41: {
    label: "طرنيب 41",
    order: ["games", "wins", "contractsWon", "contractsLost"],
    labels: { games: "مباريات", wins: "انتصارات", contractsWon: "عقود مكسوبة", contractsLost: "عقود مخسورة" },
  },
};

/** Increment counters (fire-and-forget; never throws into the game loop). */
async function record(userId, game, deltas = {}) {
  try {
    const inc = {};
    for (const [k, v] of Object.entries(deltas)) {
      const n = Number(v);
      if (Number.isFinite(n) && n !== 0) inc[`metrics.${k}`] = n;
    }
    if (Object.keys(inc).length === 0) return;
    await PlayerGameStats.updateOne(
      { user: userId, game: String(game) },
      { $inc: inc, $setOnInsert: { user: userId, game: String(game) } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn("game_stats_record_failed", { game, reason: e?.message || "unknown" });
  }
}

/** Set gauge metrics directly (maxes / averages / rolling values). */
async function setGauge(userId, game, values = {}) {
  try {
    const set = {};
    for (const [k, v] of Object.entries(values)) {
      const n = Number(v);
      if (Number.isFinite(n)) set[`metrics.${k}`] = n;
    }
    if (Object.keys(set).length === 0) return;
    await PlayerGameStats.updateOne(
      { user: userId, game: String(game) },
      { $set: set, $setOnInsert: { user: userId, game: String(game) } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn("game_stats_set_failed", { game, reason: e?.message || "unknown" });
  }
}

function _plainMetrics(m) {
  if (!m) return {};
  if (m instanceof Map) return Object.fromEntries(m);
  return { ...m };
}

/**
 * All per-game stats for a user, shaped for the profile popup:
 *   [{ key, label, stats: { metric: value, ... } }]
 * Any game/metric appears automatically; registry only adds labels/order.
 */
async function getForUser(userId) {
  const rows = await PlayerGameStats.find({ user: userId }).lean();
  return rows.map((r) => {
    const reg = METRIC_REGISTRY[r.game] || {};
    const raw = _plainMetrics(r.metrics);
    // Derived: avgPot / foldPct if the raw counters exist and weren't set directly.
    if (raw.potTotal != null && raw.handsPlayed) raw.avgPot = raw.avgPot ?? Math.round(raw.potTotal / raw.handsPlayed);
    return { key: r.game, label: reg.label || r.game, stats: raw };
  });
}

module.exports = { record, setGauge, getForUser, METRIC_REGISTRY };
