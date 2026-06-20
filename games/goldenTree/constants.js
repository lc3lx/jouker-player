/**
 * Golden Tree — core game constants.
 * Matrix: 5 reels (columns) × 3 rows. Paylines traverse columns left → right.
 */

const REEL_COUNT = 5;
const ROW_COUNT = 3;

const BET_MIN = 0.02;
const BET_MAX = 100;
const MAX_WIN_MULTIPLIER = 10000;
const REFERENCE_BET = 1;
const TARGET_RTP = 0.9649;

/** Gamble: max attempts per round (random 1–8 assigned at spin). */
const GAMBLE_MAX_ATTEMPTS_CAP = 8;
/** Gamble allowed only when win ≤ bet × 35. */
const GAMBLE_MAX_WIN_MULTIPLIER = 35;

const FREE_SPINS_PER_BONUS = 5;

const SYMBOLS = Object.freeze({
  CHERRY: "cherry",
  ORANGE: "orange",
  LEMON: "lemon",
  PLUM: "plum",
  BELL: "bell",
  GRAPES: "grapes",
  WATERMELON: "watermelon",
  SEVEN: "seven",
  WILD: "wild",
  STAR: "star",
  DOLLAR: "dollar",
});

const SCATTERS = new Set([SYMBOLS.STAR, SYMBOLS.DOLLAR]);
const LOW_FRUITS = new Set([
  SYMBOLS.CHERRY,
  SYMBOLS.ORANGE,
  SYMBOLS.LEMON,
  SYMBOLS.PLUM,
]);

/** Wild expanding reels — 1-indexed reels 2,3,4 → 0-based indices 1,2,3. */
const WILD_REELS = new Set([1, 2, 3]);

/** Star scatter reels — 1-indexed 1,3,5 → 0-based 0,2,4. */
const STAR_REELS = new Set([0, 2, 4]);

/**
 * 10 fixed paylines.
 * Each entry is [rowAtCol0, rowAtCol1, … rowAtCol4] on the 5×3 grid.
 * Row 0 = top, row 2 = bottom.
 */
const PAYLINES = Object.freeze([
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [0, 1, 1, 1, 0],
]);

/**
 * Paytable multipliers at REFERENCE_BET (1 FUN).
 * Index = matching symbol count (0-based array; index N = count N).
 */
const PAYTABLE = Object.freeze({
  [SYMBOLS.SEVEN]: [0, 0, 0.2, 1, 5, 100],
  [SYMBOLS.GRAPES]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.WATERMELON]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.BELL]: [0, 0, 0, 0.4, 0.8, 4],
  [SYMBOLS.CHERRY]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.ORANGE]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.LEMON]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.PLUM]: [0, 0, 0, 0.2, 0.6, 3],
});

const STAR_SCATTER_PAY = Object.freeze({ 3: 4 });
const DOLLAR_SCATTER_PAY = Object.freeze({ 3: 1, 4: 4, 5: 20 });

const MAIN_WILD_MULTIPLIERS = [2, 3];
const BONUS_WILD_MULTIPLIERS = [2, 3, 5];

const BUY_BONUS_COSTS = Object.freeze({
  Single: 50,
  Double: 150,
  Triple: 350,
  Random: 100,
});

const BONUS_GUARANTEED_WILDS = Object.freeze({
  Single: 1,
  Double: 2,
  Triple: 3,
});

const RESOLVED_BONUS_TYPES = ["Single", "Double", "Triple"];

function minMatchCount(symbol) {
  return symbol === SYMBOLS.SEVEN ? 2 : 3;
}

function isScatter(symbol) {
  return SCATTERS.has(symbol);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

module.exports = {
  REEL_COUNT,
  ROW_COUNT,
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  REFERENCE_BET,
  TARGET_RTP,
  GAMBLE_MAX_ATTEMPTS_CAP,
  GAMBLE_MAX_WIN_MULTIPLIER,
  FREE_SPINS_PER_BONUS,
  SYMBOLS,
  SCATTERS,
  LOW_FRUITS,
  WILD_REELS,
  STAR_REELS,
  PAYLINES,
  PAYTABLE,
  STAR_SCATTER_PAY,
  DOLLAR_SCATTER_PAY,
  MAIN_WILD_MULTIPLIERS,
  BONUS_WILD_MULTIPLIERS,
  BUY_BONUS_COSTS,
  BONUS_GUARANTEED_WILDS,
  RESOLVED_BONUS_TYPES,
  minMatchCount,
  isScatter,
  roundMoney,
};
