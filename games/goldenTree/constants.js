/**
 * Golden Tree — core game constants.
 * Matrix: 5 reels (columns) × 3 rows.
 * Wins: 3+ matching symbols/wilds on contiguous left→right reels,
 * starting on reel 0. A connection may move horizontally or diagonally to a
 * touching cell on the next reel; a gap still ends the run — no skipping
 * columns or jumping over a row.
 */

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

/** Contiguous L→R from reel 0 only — not “count anywhere” on the board. */
const WIN_RULES_VERSION = "contiguous-col0-v1";

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
  STAR: "star",
  DOLLAR: "dollar",
  /** Match-3 scratch trigger (same as Zeus / Atlantis). */
  JACKPOT: "jackpot",
});

const SCATTERS = new Set([SYMBOLS.STAR, SYMBOLS.DOLLAR]);
/** Symbols that break adjacent-path wins (scatters + jackpot scatter). */
const LINE_BREAKERS = new Set([
  SYMBOLS.STAR,
  SYMBOLS.DOLLAR,
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

/** Star scatter reels — 1-indexed 1,3,5 → 0-based 0,2,4. */
const STAR_REELS = new Set([0, 2, 4]);

/**
 * Legacy 10 fixed paylines (kept for reference / UI diagrams).
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
 * All left→right paths of length REEL_COUNT with exactly one cell on every
 * consecutive reel. The next symbol must be in the same row or a directly
 * touching diagonal row (absolute row difference ≤ 1).
 */
function buildAdjacentPaths() {
  const paths = [];

  function walk(path) {
    if (path.length === REEL_COUNT) {
      paths.push(path.slice());
      return;
    }
    const previousRow = path[path.length - 1];
    const firstNextRow = Math.max(0, previousRow - 1);
    const lastNextRow = Math.min(ROW_COUNT - 1, previousRow + 1);
    for (let nextRow = firstNextRow; nextRow <= lastNextRow; nextRow += 1) {
      path.push(nextRow);
      walk(path);
      path.pop();
    }
  }

  for (let row = 0; row < ROW_COUNT; row += 1) {
    walk([row]);
  }

  return Object.freeze(paths.map((p) => Object.freeze(p)));
}

const ADJACENT_PATHS = buildAdjacentPaths();

/**
 * Paytable multipliers at REFERENCE_BET (1 FUN).
 * Index = matching symbol count (0-based array; index N = count N).
 */
const PAYTABLE = Object.freeze({
  [SYMBOLS.SEVEN]: [0, 0, 0, 1, 5, 100],
  [SYMBOLS.GRAPES]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.WATERMELON]: [0, 0, 0, 0.8, 2.4, 14],
  [SYMBOLS.BELL]: [0, 0, 0, 0.4, 0.8, 4],
  [SYMBOLS.BANANA]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.CHERRY]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.ORANGE]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.PINEAPPLE]: [0, 0, 0, 0.2, 0.6, 3],
  [SYMBOLS.PLUM]: [0, 0, 0, 0.2, 0.6, 3],
});

const STAR_SCATTER_PAY = Object.freeze({ 3: 4 });
const DOLLAR_SCATTER_PAY = Object.freeze({ 3: 1, 4: 4, 5: 20 });

const MAIN_WILD_MULTIPLIERS = [2, 3];
const BONUS_WILD_MULTIPLIERS = [2, 3, 5];

/**
 * Public buy-bonus identifier retained for API compatibility with existing
 * clients. It is not a promise of three trees: bonus spins use the bonus
 * reel strips and trees land randomly.
 */
const BUY_BONUS_TYPE = "Triple";
const BUY_BONUS_COST = 350;

function minMatchCount() {
  return 3;
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
  WIN_RULES_VERSION,
  SYMBOLS,
  SCATTERS,
  LINE_BREAKERS,
  LOW_FRUITS,
  WILD_REELS,
  WILD_ROW,
  STAR_REELS,
  PAYLINES,
  ADJACENT_PATHS,
  PAYTABLE,
  STAR_SCATTER_PAY,
  DOLLAR_SCATTER_PAY,
  MAIN_WILD_MULTIPLIERS,
  BONUS_WILD_MULTIPLIERS,
  BUY_BONUS_TYPE,
  BUY_BONUS_COST,
  minMatchCount,
  isScatter,
  isLineBreaker,
  roundMoney,
};
