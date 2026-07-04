"use strict";

/**
 * VIP membership configuration — single source of truth for levels, pricing,
 * benefits and reward math. Pure module (no mongoose / no I/O) so it is unit
 * testable and safely requirable from games, services and tests.
 */

const VIP_LEVELS = ["bronze", "silver", "gold", "platinum"];

/** Numeric rank used for upgrade/downgrade + queue priority (higher = better). */
const VIP_LEVEL_RANK = { bronze: 1, silver: 2, gold: 3, platinum: 4 };

const SUBSCRIPTION_DAYS = 30;

/**
 * Per-level benefit table.
 *  - priceUsd / priceCents  — monthly subscription price
 *  - cashbackPercent        — weekly loss cashback (losses only, wins ignored)
 *  - weeklyCashbackCapChips — cashback never exceeds this (configured limit)
 *  - dailyChips             — daily VIP bonus, separate from the normal daily bonus
 *  - quiz                   — daily VIP quiz access (Gold+)
 *  - priorityQueue          — matchmaking priority (Silver+), Platinum = highest
 */
const VIP_LEVEL_CONFIG = {
  bronze: {
    level: "bronze",
    rank: 1,
    priceUsd: 9.99,
    priceCents: 999,
    cashbackPercent: 5,
    weeklyCashbackCapChips: 500_000,
    dailyChips: 100_000,
    quiz: false,
    priorityQueue: false,
    queueBoostMs: 0,
  },
  silver: {
    level: "silver",
    rank: 2,
    priceUsd: 19.99,
    priceCents: 1999,
    cashbackPercent: 10,
    weeklyCashbackCapChips: 1_500_000,
    dailyChips: 200_000,
    quiz: false,
    priorityQueue: true,
    queueBoostMs: 60 * 60 * 1000,
  },
  gold: {
    level: "gold",
    rank: 3,
    priceUsd: 29.99,
    priceCents: 2999,
    cashbackPercent: 20,
    weeklyCashbackCapChips: 4_000_000,
    dailyChips: 300_000,
    quiz: true,
    priorityQueue: true,
    queueBoostMs: 2 * 60 * 60 * 1000,
  },
  platinum: {
    level: "platinum",
    rank: 4,
    priceUsd: 49.99,
    priceCents: 4999,
    cashbackPercent: 35,
    weeklyCashbackCapChips: 10_000_000,
    dailyChips: 500_000,
    quiz: true,
    priorityQueue: true,
    // Highest priority queue for Platinum.
    queueBoostMs: 6 * 60 * 60 * 1000,
  },
};

/** Wallet ledger `type` values counted as game losses for weekly cashback. */
const CASHBACK_LOSS_TX_TYPES = ["bet", "game_loss", "debit"];

/** Default quiz reward when a question has no explicit reward configured. */
const VIP_QUIZ_DEFAULT_REWARD = Math.max(
  0,
  parseInt(process.env.VIP_QUIZ_DEFAULT_REWARD || "150000", 10) || 150000
);

function isValidVipLevel(level) {
  return typeof level === "string" && VIP_LEVELS.includes(level);
}

function normalizeVipLevel(level) {
  const l = String(level || "").toLowerCase().trim();
  return isValidVipLevel(l) ? l : null;
}

function vipLevelRank(level) {
  const l = normalizeVipLevel(level);
  return l ? VIP_LEVEL_RANK[l] : 0;
}

function vipLevelConfig(level) {
  const l = normalizeVipLevel(level);
  return l ? VIP_LEVEL_CONFIG[l] : null;
}

/**
 * Weekly cashback = floor(losses * percent) capped at the configured limit.
 * Losses only — wins are ignored by design.
 */
function computeCashbackAmount(level, weeklyLosses) {
  const cfg = vipLevelConfig(level);
  const losses = Math.max(0, Math.floor(Number(weeklyLosses) || 0));
  if (!cfg || losses <= 0) return 0;
  const raw = Math.floor((losses * cfg.cashbackPercent) / 100);
  return Math.min(raw, cfg.weeklyCashbackCapChips);
}

// ─── UTC week helpers (cashback weeks run Monday 00:00 UTC → Monday) ───────

function utcDayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Monday 00:00:00 UTC of the week containing `d`. */
function mondayOfUtc(d = new Date()) {
  const day = d.getUTCDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? 6 : day - 1;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
}

/**
 * The most recent fully-completed cashback week relative to `now`:
 * [previous Monday, this Monday). Claimable starting every Monday.
 */
function previousWeekRangeUtc(now = new Date()) {
  const end = mondayOfUtc(now);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { start, end, weekKey: utcDayStr(start) };
}

/** Deterministic per-user daily question index (stable all day, no repeats race). */
function dailyQuestionIndex(userId, dayUtc, poolSize) {
  const n = Math.max(1, Math.floor(Number(poolSize) || 1));
  const s = `${userId}:${dayUtc}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h % n;
}

/** Public benefits payload for clients (per level). */
function publicBenefits(level) {
  const cfg = vipLevelConfig(level);
  if (!cfg) return null;
  return {
    level: cfg.level,
    rank: cfg.rank,
    priceUsd: cfg.priceUsd,
    cashbackPercent: cfg.cashbackPercent,
    weeklyCashbackCapChips: cfg.weeklyCashbackCapChips,
    dailyChips: cfg.dailyChips,
    quiz: cfg.quiz,
    priorityQueue: cfg.priorityQueue,
    highestPriority: cfg.level === "platinum",
  };
}

module.exports = {
  VIP_LEVELS,
  VIP_LEVEL_RANK,
  VIP_LEVEL_CONFIG,
  SUBSCRIPTION_DAYS,
  CASHBACK_LOSS_TX_TYPES,
  VIP_QUIZ_DEFAULT_REWARD,
  isValidVipLevel,
  normalizeVipLevel,
  vipLevelRank,
  vipLevelConfig,
  computeCashbackAmount,
  utcDayStr,
  mondayOfUtc,
  previousWeekRangeUtc,
  dailyQuestionIndex,
  publicBenefits,
};
