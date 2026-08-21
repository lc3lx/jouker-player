/**
 * Poseidon – The God of Atlantis — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows. Scatter-pays: 7+ matching symbols
 * anywhere on screen pay, winners explode and symbols tumble in until no new
 * win forms (cascade continues while any type still has 7+). Multiplier
 * plaques (x2 → x1000) stay on screen for the whole tumbling sequence; when
 * the sequence ends with a win, their sum multiplies it — in the base game
 * AND in free spins (per-spin, no accumulation). Plaques are also the
 * free-spins trigger: 4+ plaques in base game award free spins; during free
 * spins (natural or bought) 3+ plaques add more spins.
 *
 * RTP was originally tuned for MIN_MATCH=8; lowering to 7 raises hit rate.
 * Re-tune with the seeded sim in test/poseidon.test.js if needed.
 */

const REEL_COUNT = 6;
const ROW_COUNT = 5;

const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MAX_WIN_MULTIPLIER = 5000;

/** 4+ multiplier plaques in the base game trigger free spins. */
const TRIGGER_NATURAL_MIN = 4;
/** 3+ plaques during free spins (incl. bought bonus) award +5 spins. */
const TRIGGER_RETRIGGER_MIN = 3;
/** @deprecated use TRIGGER_NATURAL_MIN / TRIGGER_RETRIGGER_MIN */
const TRIGGER_MIN_MULTIPLIERS = TRIGGER_RETRIGGER_MIN;
const FREE_SPINS_NATURAL = 5;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;

/** Buy bonus: 10 free spins, cost in bet multiples (EV-matched by sim). */
const BUY_BONUS_COST = 30;
/** Super buy bonus — 3× standard cost (UI tier). */
const SUPER_BUY_BONUS_COST = 90;

const SYMBOLS = Object.freeze({
  // low pays (royals — all pay the same)
  A: "a",
  E: "e",
  N: "n",
  S: "s",
  // high pays
  STARFISH: "starfish",
  CORAL: "coral",
  FISH: "fish",
  CROWN: "crown",
  PEARL: "pearl",
});

/**
 * Multiplier plaques are encoded straight into the matrix as `x<value>`.
 * Face value applies in full to the win; high plaques are rare so RTP stays
 * sane without a soft-cap on applied.
 */
const MULTIPLIER_VALUES = Object.freeze([2, 5, 10, 20, 50, 100, 200, 500, 1000]);

/** Base-game plaque value weights — heavily skewed to small faces. */
const BASE_MULTIPLIER_WEIGHTS = Object.freeze([
  82, 11, 4.2, 1.6, 0.7, 0.3, 0.12, 0.05, 0.02,
]);

/** Buy-bonus / free-spins — still richer, but x500/x1000 stay rare. */
const BONUS_MULTIPLIER_WEIGHTS = Object.freeze([
  62, 16, 10, 5.5, 3, 1.8, 0.9, 0.45, 0.2,
]);

/**
 * When a mid/big plaque (x20+) is already on screen, further draws collapse
 * toward small values so several huge multipliers rarely stack.
 */
const SUPPRESSED_MULTIPLIER_WEIGHTS = Object.freeze([
  88, 9, 2.2, 0.5, 0.15, 0.05, 0.015, 0.005, 0.002,
]);

/** @deprecated kept for any external reads — prefer BASE/BONUS_MULTIPLIER_WEIGHTS */
const MULTIPLIER_GATES = Object.freeze([
  0.48, 0.35, 0.33, 0.32, 0.35, 0.4, 0.4, 0.35, 0.4,
]);

/** Plaques at/above this count as "big" for stacking suppression. */
const BIG_MULTIPLIER_THRESHOLD = 20;

/**
 * Plaque face values multiply the win in full (no soft-cap on applied).
 * Overall payout is still bounded by [MAX_WIN_MULTIPLIER] × bet.
 * Kept exports for API compatibility; caps are effectively uncapped.
 */
const APPLIED_MULTIPLIER_CAP_BASE = Number.POSITIVE_INFINITY;
const APPLIED_MULTIPLIER_CAP_BONUS = Number.POSITIVE_INFINITY;

/** Face-value plaque sum used for payout (uncapped; display matches pay). */
function appliedMultiplierFor(sum, isBonus = false) {
  if (!(sum > 0)) return 1;
  return sum;
}

const PAYING_SYMBOLS = Object.freeze([
  SYMBOLS.CROWN,
  SYMBOLS.FISH,
  SYMBOLS.PEARL,
  SYMBOLS.STARFISH,
  SYMBOLS.CORAL,
  SYMBOLS.A,
  SYMBOLS.E,
  SYMBOLS.N,
  SYMBOLS.S,
]);

/**
 * Anywhere-pays paytable in bet multiples.
 * Bands: 7–9 matches / 10–11 matches / 12+ matches.
 * Ranking: crown (max 5×) > fish > pearl > starfish > coral > letters (min 1×).
 */
const LETTER_PAYS = Object.freeze([1.0, 1.15, 1.5]);
const PAYTABLE = Object.freeze({
  [SYMBOLS.CROWN]: [2.0, 3.5, 5.0],
  [SYMBOLS.FISH]: [1.7, 2.8, 4.2],
  [SYMBOLS.PEARL]: [1.5, 2.3, 3.5],
  [SYMBOLS.STARFISH]: [1.3, 1.85, 2.8],
  [SYMBOLS.CORAL]: [1.15, 1.5, 2.2],
  [SYMBOLS.A]: LETTER_PAYS,
  [SYMBOLS.E]: LETTER_PAYS,
  [SYMBOLS.N]: LETTER_PAYS,
  [SYMBOLS.S]: LETTER_PAYS,
});

/**
 * Per-cell draw weights. Independent weighted draws per cell (not physical
 * strips) — RTP is enforced by simulation in test/poseidon.test.js.
 * Letters are flattened so 7-of-a-kind stays exciting but not constant.
 */
/**
 * "jackpot" is a scatter symbol — 3+ on the final matrix trigger a jackpot
 * round. Weight sourced from jackpotConstants.JACKPOT_BASE_WEIGHT (0.25).
 * Kept here inline to avoid a circular dependency between constants.js and
 * the jackpot sub-module.
 */
const BASE_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 10],
  [SYMBOLS.N, 10],
  [SYMBOLS.E, 10],
  [SYMBOLS.A, 10],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 7.5],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 5],
  ["mult", 0.22],
  ["jackpot", 0.25],
]);

/** Free spins: plaques rain more often; high faces stay rare for RTP. */
const BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 10],
  [SYMBOLS.N, 10],
  [SYMBOLS.E, 10],
  [SYMBOLS.A, 10],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 7.5],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 5],
  ["mult", 0.55],
  ["jackpot", 0.25],
]);

/** Win presentation tiers in bet multiples (client shows matching banner). */
const WIN_TIERS = Object.freeze([
  ["jackpot", 250],
  ["grand", 100],
  ["mega", 50],
  ["super", 25],
]);

const MIN_MATCH = 7;

function isMultiplier(cell) {
  return typeof cell === "string" && cell.charCodeAt(0) === 120 /* 'x' */;
}

function multiplierValue(cell) {
  return isMultiplier(cell) ? Number(cell.slice(1)) : 0;
}

function payoutFor(symbol, count) {
  const bands = PAYTABLE[symbol];
  if (!bands || count < MIN_MATCH) return 0;
  if (count >= 12) return bands[2];
  if (count >= 10) return bands[1];
  return bands[0];
}

function winTierFor(betMultiple) {
  for (const [tier, threshold] of WIN_TIERS) {
    if (betMultiple >= threshold) return tier;
  }
  return null;
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
  TRIGGER_NATURAL_MIN,
  TRIGGER_RETRIGGER_MIN,
  TRIGGER_MIN_MULTIPLIERS,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  RETRIGGER_AWARD,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  SYMBOLS,
  MULTIPLIER_VALUES,
  MULTIPLIER_GATES,
  BASE_MULTIPLIER_WEIGHTS,
  BONUS_MULTIPLIER_WEIGHTS,
  SUPPRESSED_MULTIPLIER_WEIGHTS,
  BIG_MULTIPLIER_THRESHOLD,
  APPLIED_MULTIPLIER_CAP_BASE,
  APPLIED_MULTIPLIER_CAP_BONUS,
  appliedMultiplierFor,
  PAYING_SYMBOLS,
  PAYTABLE,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  WIN_TIERS,
  MIN_MATCH,
  isMultiplier,
  multiplierValue,
  payoutFor,
  winTierFor,
  roundMoney,
};
