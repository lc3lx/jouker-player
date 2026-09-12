/**
 * Zenobia — Queen of the East (زنوبيا ملكة الشرق) — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows — the same board shape and symbol
 * distribution style as Poseidon, but the win rule is a hybrid of the two
 * existing slots and belongs to neither:
 *
 *   "Caravan Route" — Golden Tree's connected adjacent-path rule generalised
 *   to a 6-reel board, then resolved inside Poseidon's tumble loop.
 *
 *   • A win is a maximal left→right route starting on reel 0, one step per
 *     reel, touching the previous cell (|Δrow| ≤ 1), all cells the same
 *     symbol. Minimum route length is [MIN_ROUTE] of the 6 reels.
 *   • Every geometrically distinct maximal route pays (zig-zags included).
 *   • Winning routes shatter, survivors fall, the board refills from the top,
 *     and the whole thing re-evaluates until no route forms.
 *
 * "Bonus Box" multipliers — the plaque board Zenobia holds beside the reels.
 * Every plaque that lands at any point during a tumble sequence banks into the
 * box (Poseidon only counts the final screen; here the box visibly fills as the
 * cascade runs). When the sequence ends on a win, the banked total multiplies
 * it. Base game: the box empties every spin. Free spins: the box carries
 * across spins and only grows on winning spins.
 *
 * Free spins are driven by the BONUS coin scatter, not by plaque count.
 *
 * RTP is enforced by the seeded simulation in test/zenobia.test.js — re-run it
 * after touching any weight or paytable entry.
 */

const REEL_COUNT = 6;
const ROW_COUNT = 5;

const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MAX_WIN_MULTIPLIER = 5000;
const TARGET_RTP = 0.965;

/** Shortest paying caravan route, in reels. */
const MIN_ROUTE = 3;

/** BONUS coins on the final screen that open free spins from the base game. */
const TRIGGER_NATURAL_MIN = 3;
/** BONUS coins during free spins that award [RETRIGGER_AWARD] more. */
const TRIGGER_RETRIGGER_MIN = 2;
const FREE_SPINS_NATURAL = 10;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;

/** Buy bonus cost in bet multiples (EV-matched by the sim). */
const BUY_BONUS_COST = 37.5;
/** Super buy bonus — richer plaque table, never below [SUPER_MULTIPLIER_MIN]. */
const SUPER_BUY_BONUS_COST = 138.5;

const SYMBOLS = Object.freeze({
  // low pays — carved stone letters (all pay the same)
  A: "a",
  E: "e",
  N: "n",
  S: "s",
  // high pays — Palmyran relics
  RING: "ring",
  SPEAR: "spear",
  POT: "pot",
  NECKLACE: "necklace",
  THRONE: "throne",
  QUEEN: "queen",
});

/** Free-spins scatter — the gold BONUS coin. Never part of a route. */
const SCATTER = "bonus";

/** Match-3 jackpot scatter — same cell id as Poseidon / Zeus / Golden Tree. */
const JACKPOT = "jackpot";

/**
 * Plaque faces, encoded straight into the matrix as `x<value>`.
 * Gold plaques run x2–x9, royal-blue plaques x10–x1000 — the split matches the
 * two artwork sets and the two Bonus Box plates.
 */
const MULTIPLIER_VALUES = Object.freeze([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 50, 100, 200, 500, 1000,
]);

/** Royal-blue plaques start here; below this the plaque art is gold. */
const ROYAL_MULTIPLIER_MIN = 10;

/** Base-game plaque faces — heavily skewed to the small gold end. */
const BASE_MULTIPLIER_WEIGHTS = Object.freeze([
  30, 21, 15, 11, 7.5, 5, 3.4, 2.4, 1.9, 1.0, 0.62, 0.3, 0.14, 0.08, 0.04, 0.012, 0.004,
]);

/** Free spins — the royal end opens up, x200/x500/x1000 stay rare. */
const BONUS_MULTIPLIER_WEIGHTS = Object.freeze([
  22, 17, 13.5, 11, 8.5, 6.5, 5, 4, 3.6, 2.5, 1.7, 1.0, 0.55, 0.16, 0.07, 0.055, 0.018,
]);

/**
 * Once a royal plaque (x20+) is already banked this sequence, later draws
 * collapse toward the gold end so several huge faces rarely stack.
 */
const SUPPRESSED_MULTIPLIER_WEIGHTS = Object.freeze([
  36, 24, 16, 10, 6, 3.4, 1.9, 1.1, 0.75, 0.32, 0.15, 0.06, 0.025, 0.012, 0.005, 0.0015, 0.0005,
]);

/** Plaques at/above this face count as "big" for stacking suppression. */
const BIG_MULTIPLIER_THRESHOLD = 20;
/** Super buy-bonus: every plaque face is at least this. */
const SUPER_MULTIPLIER_MIN = 10;

const PAYING_SYMBOLS = Object.freeze([
  SYMBOLS.QUEEN,
  SYMBOLS.THRONE,
  SYMBOLS.NECKLACE,
  SYMBOLS.POT,
  SYMBOLS.SPEAR,
  SYMBOLS.RING,
  SYMBOLS.A,
  SYMBOLS.E,
  SYMBOLS.N,
  SYMBOLS.S,
]);

/**
 * Route paytable in bet multiples, indexed by route length.
 * Index 0..3 are unreachable (routes shorter than [MIN_ROUTE] never pay);
 * index 4 / 5 / 6 are the real bands.
 * Ranking: queen (max 20×) > throne > necklace > pot > spear > ring > letters.
 */
const LETTER_PAYS = Object.freeze([0, 0, 0, 0.14, 0.46, 1.4, 4.6]);
const PAYTABLE = Object.freeze({
  [SYMBOLS.QUEEN]: [0, 0, 0, 0.56, 2.3, 7.0, 18.5],
  [SYMBOLS.THRONE]: [0, 0, 0, 0.46, 1.85, 5.6, 15],
  [SYMBOLS.NECKLACE]: [0, 0, 0, 0.37, 1.4, 4.2, 11],
  [SYMBOLS.POT]: [0, 0, 0, 0.28, 1.1, 3.25, 8.4],
  [SYMBOLS.SPEAR]: [0, 0, 0, 0.23, 0.84, 2.4, 6.5],
  [SYMBOLS.RING]: [0, 0, 0, 0.19, 0.65, 1.85, 5.1],
  [SYMBOLS.A]: LETTER_PAYS,
  [SYMBOLS.E]: LETTER_PAYS,
  [SYMBOLS.N]: LETTER_PAYS,
  [SYMBOLS.S]: LETTER_PAYS,
});

/**
 * Per-cell draw weights — independent weighted draws per cell, not physical
 * strips. Tuned for ~35% win rate.
 */
const BASE_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 12],
  [SYMBOLS.N, 12],
  [SYMBOLS.E, 12],
  [SYMBOLS.A, 12],
  [SYMBOLS.RING, 9.5],
  [SYMBOLS.SPEAR, 9],
  [SYMBOLS.POT, 8],
  [SYMBOLS.NECKLACE, 7],
  [SYMBOLS.THRONE, 6],
  [SYMBOLS.QUEEN, 5],
  ["mult", 1.9],
  [SCATTER, 0.96],
  [JACKPOT, 0.42],
]);

/** Free spins: plaques rain more often; scatters tuned for retrigger. */
const BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 12],
  [SYMBOLS.N, 12],
  [SYMBOLS.E, 12],
  [SYMBOLS.A, 12],
  [SYMBOLS.RING, 9.5],
  [SYMBOLS.SPEAR, 9],
  [SYMBOLS.POT, 8],
  [SYMBOLS.NECKLACE, 7],
  [SYMBOLS.THRONE, 6],
  [SYMBOLS.QUEEN, 5],
  ["mult", 2.6],
  [SCATTER, 0.7],
  [JACKPOT, 0.42],
]);

/** Win presentation tiers in bet multiples (client shows the matching banner). */
const WIN_TIERS = Object.freeze([
  ["royal", 250],
  ["grand", 100],
  ["mega", 50],
  ["super", 25],
]);

function isMultiplier(cell) {
  return typeof cell === "string" && cell.charCodeAt(0) === 120 /* 'x' */;
}

function multiplierValue(cell) {
  return isMultiplier(cell) ? Number(cell.slice(1)) : 0;
}

function isScatter(cell) {
  return cell === SCATTER;
}

function isJackpot(cell) {
  return cell === JACKPOT;
}

/** Plaques, BONUS coins, and jackpot scatters sit outside routes. */
function isRouteBreaker(cell) {
  return isMultiplier(cell) || isScatter(cell) || isJackpot(cell);
}

function payoutFor(symbol, length) {
  const bands = PAYTABLE[symbol];
  if (!bands || length < MIN_ROUTE) return 0;
  return bands[Math.min(length, bands.length - 1)] || 0;
}

function winTierFor(betMultiple) {
  for (const [tier, threshold] of WIN_TIERS) {
    if (betMultiple >= threshold) return tier;
  }
  return null;
}

/**
 * Banked plaque faces multiply the win in full — the Bonus Box shows exactly
 * what it pays. Total payout is still bounded by [MAX_WIN_MULTIPLIER] × bet.
 */
function appliedMultiplierFor(sum) {
  if (!(sum > 0)) return 1;
  return sum;
}

/**
 * Box arithmetic for one spin.
 *
 * Base game: the box holds only this sequence's plaques and empties after.
 * Free spins: the box carries across spins, but a losing spin banks nothing —
 * its plaques are still counted for presentation, just not added to the total.
 */
function resolvePayoutMultiplier({
  baseWin = 0,
  plaqueSum = 0,
  carried = 0,
  isFreeSpin = false,
} = {}) {
  const won = Number(baseWin) > 0;
  const plaques = won ? Math.max(0, Number(plaqueSum) || 0) : 0;
  const prev = Math.max(0, Number(carried) || 0);
  const nextCarried = isFreeSpin ? prev + plaques : 0;
  const pool = isFreeSpin ? nextCarried : plaques;
  const applied = won && pool > 0 ? appliedMultiplierFor(pool) : 1;
  return { applied, nextCarried, plaques };
}

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

module.exports = {
  REEL_COUNT,
  ROW_COUNT,
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  TARGET_RTP,
  MIN_ROUTE,
  TRIGGER_NATURAL_MIN,
  TRIGGER_RETRIGGER_MIN,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  RETRIGGER_AWARD,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  SYMBOLS,
  SCATTER,
  JACKPOT,
  MULTIPLIER_VALUES,
  ROYAL_MULTIPLIER_MIN,
  BASE_MULTIPLIER_WEIGHTS,
  BONUS_MULTIPLIER_WEIGHTS,
  SUPPRESSED_MULTIPLIER_WEIGHTS,
  BIG_MULTIPLIER_THRESHOLD,
  SUPER_MULTIPLIER_MIN,
  PAYING_SYMBOLS,
  PAYTABLE,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  WIN_TIERS,
  isMultiplier,
  multiplierValue,
  isScatter,
  isJackpot,
  isRouteBreaker,
  payoutFor,
  winTierFor,
  appliedMultiplierFor,
  resolvePayoutMultiplier,
  roundMoney,
};
