/**
 * Golden Tree — core game constants.
 * Matrix: 5 reels (columns) × 3 rows.
 *
 * Win rule: 10 fixed paylines evaluated left-to-right from column 0.
 * Each payline defines row indices per column. Wilds substitute.
 * Seven symbol requires only 2 consecutive matches; all others need 3.
 */

/** Minimum run length for regular line symbols. */
const MIN_CONSECUTIVE = 3;

/** Seven only needs 2 consecutive to win. */
const SEVEN_MIN_CONSECUTIVE = 2;

const REEL_COUNT = 5;
const ROW_COUNT = 3;

const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MAX_WIN_MULTIPLIER = 10000;
const REFERENCE_BET = 1;
const TARGET_RTP = 0.9649;

/** Progressive jackpot: 1 in JACKPOT_ODDS on paid main spins only. */
const JACKPOT_ODDS = 1000;
/** Jackpot award = bet × JACKPOT_MULTIPLIER (then capped by MAX_WIN_MULTIPLIER). */
const JACKPOT_MULTIPLIER = 1000;

/** Gamble: max attempts per round (random 1–8 assigned at spin). */
const GAMBLE_MAX_ATTEMPTS_CAP = 8;
/** Gamble allowed only when win ≤ bet × 35. */
const GAMBLE_MAX_WIN_MULTIPLIER = 35;

const FREE_SPINS_PER_BONUS = 5;

/** 10 fixed paylines, left-to-right evaluation from col 0. */
const WIN_RULES_VERSION = "fixed-10-paylines-seven2-v8";

/**
 * @deprecated Removed — seven+tree adjacent pairs no longer pay.
 * Kept export as 0 so any stale import cannot award a win by accident.
 */
const SEVEN_TREE_ADJACENT_MULT = 0;

const SYMBOLS = Object.freeze({
  CHERRY: "cherry",
  ORANGE: "orange",
  PINEAPPLE: "pineapple",
  PLUM: "plum",
  BELL: "bell",
  GRAPES: "grapes",
  WATERMELON: "watermelon",
  BANANA: "banana",
  SEVEN: "seven",
  WILD: "wild",
  /** Match-3 scratch trigger (same as Zeus / Atlantis). */
  JACKPOT: "jackpot",
});

const SCATTERS = new Set();
/** Symbols that break horizontal line wins (jackpot scatter). */
const LINE_BREAKERS = new Set([
  SYMBOLS.JACKPOT,
]);
const LOW_FRUITS = new Set([
  SYMBOLS.CHERRY,
  SYMBOLS.ORANGE,
  SYMBOLS.PINEAPPLE,
  SYMBOLS.PLUM,
  SYMBOLS.BANANA,
]);

/** Wild expanding reels — 1-indexed reels 2,3,4 → 0-based indices 1,2,3. */
const WILD_REELS = new Set([1, 2, 3]);

/** Wild trees appear only on the middle row (0=top, 1=middle, 2=bottom). */
const WILD_ROW = 1;

/**
 * 10 fixed paylines — each entry is [rowAtCol0 … rowAtCol4].
 * Row 0 = top, row 1 = middle, row 2 = bottom.
 */
const PAYLINES = Object.freeze([
  [1, 1, 1, 1, 1], // Line 1: Middle row
  [0, 0, 0, 0, 0], // Line 2: Top row
  [2, 2, 2, 2, 2], // Line 3: Bottom row
  [0, 1, 2, 1, 0], // Line 4: V-shape
  [2, 1, 0, 1, 2], // Line 5: Inverted V
  [0, 0, 1, 2, 2], // Line 6: Descending step
  [2, 2, 1, 0, 0], // Line 7: Ascending step
  [1, 0, 0, 0, 1], // Line 8: U-shape top
  [0, 1, 1, 1, 0], // Line 9: Flat bump down
  [2, 1, 1, 1, 2], // Line 10: Flat bump up
]);

/**
 * Paytable multipliers at REFERENCE_BET (1 FUN).
 * Index = matching symbol count (0-based array; index N = count N).
 * Seven has a payout at index 2 (2-match rule).
 */
const PAYTABLE = Object.freeze({
  [SYMBOLS.SEVEN]: [0, 0, 0.5, 1, 5, 100],
  [SYMBOLS.GRAPES]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.WATERMELON]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.BELL]: [0, 0, 0, 0.4, 0.8, 4],
  [SYMBOLS.BANANA]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.CHERRY]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.ORANGE]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.PINEAPPLE]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.PLUM]: [0, 0, 0, 0.2, 0.6, 3],
});

const MAIN_WILD_MULTIPLIERS = [2, 3];
const BONUS_WILD_MULTIPLIERS = [2, 3, 5];

/**
 * Public buy-bonus identifier retained for API compatibility with existing
 * clients. Buy bonus forces 3 trees on columns 1-3 during the initial spin.
 */
const BUY_BONUS_TYPE = "Triple";
const BUY_BONUS_COST = 350;

function minMatchCount(symbol) {
  if (symbol === SYMBOLS.SEVEN) return SEVEN_MIN_CONSECUTIVE;
  return MIN_CONSECUTIVE;
}

function isScatter(symbol) {
  return SCATTERS.has(symbol);
}

function isLineBreaker(symbol) {
  return LINE_BREAKERS.has(symbol);
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
  REFERENCE_BET,
  TARGET_RTP,
  JACKPOT_ODDS,
  JACKPOT_MULTIPLIER,
  GAMBLE_MAX_ATTEMPTS_CAP,
  GAMBLE_MAX_WIN_MULTIPLIER,
  FREE_SPINS_PER_BONUS,
  MIN_CONSECUTIVE,
  SEVEN_MIN_CONSECUTIVE,
  WIN_RULES_VERSION,
  SEVEN_TREE_ADJACENT_MULT,
  SYMBOLS,
  SCATTERS,
  LINE_BREAKERS,
  LOW_FRUITS,
  WILD_REELS,
  WILD_ROW,
  PAYLINES,
  PAYTABLE,
  MAIN_WILD_MULTIPLIERS,
  BONUS_WILD_MULTIPLIERS,
  BUY_BONUS_TYPE,
  BUY_BONUS_COST,
  minMatchCount,
  isScatter,
  isLineBreaker,
  roundMoney,
};
