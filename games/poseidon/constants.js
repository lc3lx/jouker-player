/**
 * Poseidon – The God of Atlantis — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows. Scatter-pays: 7+ matching symbols
 * anywhere on screen pay, winners explode and symbols tumble in until no new
 * win forms (cascade continues while any type still has 7+). Multiplier
 * plaques (x2 → x1000) stay on screen for the whole tumbling sequence; when
 * the sequence ends with a win, their sum multiplies it — in the base game
 * AND in free spins (per-spin, no accumulation). Plaques are also the
 * free-spins trigger: 3+ on screen award free spins.
 *
 * RTP was originally tuned for MIN_MATCH=8; lowering to 7 raises hit rate.
 * Re-tune with the seeded sim in test/poseidon.test.js if needed.
 */

const REEL_COUNT = 6;
const ROW_COUNT = 5;

const BET_MIN = 10000;
const BET_MAX = 40000000;
const MAX_WIN_MULTIPLIER = 5000;

/** 3+ multiplier plaques on the final screen trigger free spins. */
const TRIGGER_MIN_MULTIPLIERS = 3;
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
 * Values are weighted (not the old ultra-rare gate cascade) so x20–x1000
 * actually show up — richer in free spins / buy-bonus. Soft-capping in the
 * spin engine still makes stacking several big plaques uncommon.
 */
const MULTIPLIER_VALUES = Object.freeze([2, 5, 10, 20, 50, 100, 200, 500, 1000]);

/** Base-game plaque value weights (sum ≈ 100). */
const BASE_MULTIPLIER_WEIGHTS = Object.freeze([
  55, 18, 12, 6.5, 3.8, 2.4, 1.2, 0.7, 0.4,
]);

/** Buy-bonus / free-spins — mid & high plaques land more often. */
const BONUS_MULTIPLIER_WEIGHTS = Object.freeze([
  36, 16, 14, 11, 8, 6, 4, 3, 2,
]);

/**
 * When a mid/big plaque (x20+) is already on screen, further draws collapse
 * toward small values so several huge multipliers rarely stack.
 */
const SUPPRESSED_MULTIPLIER_WEIGHTS = Object.freeze([
  75, 16, 7, 1.4, 0.4, 0.15, 0.04, 0.01, 0.005,
]);

/** @deprecated kept for any external reads — prefer BASE/BONUS_MULTIPLIER_WEIGHTS */
const MULTIPLIER_GATES = Object.freeze([
  0.48, 0.35, 0.33, 0.32, 0.35, 0.4, 0.4, 0.35, 0.4,
]);

/** Plaques at/above this count as "big" for soft-cap stacking. */
const BIG_MULTIPLIER_THRESHOLD = 20;

/**
 * Hard ceiling on how large a plaque *sum* can multiply the win.
 * Plaques still display their full face value (x1000 can show), but the
 * applied product is capped so RTP stays sane. Bonus allows a higher ceiling.
 */
const APPLIED_MULTIPLIER_CAP_BASE = 12;
const APPLIED_MULTIPLIER_CAP_BONUS = 40;

/** Face-value plaque sum, clamped for payout (display stays uncapped). */
function appliedMultiplierFor(sum, isBonus = false) {
  if (!(sum > 0)) return 1;
  const cap = isBonus
    ? APPLIED_MULTIPLIER_CAP_BONUS
    : APPLIED_MULTIPLIER_CAP_BASE;
  return Math.min(sum, cap);
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
 * Ranking per design: crown > fish > pearl > starfish > coral > letters
 * (letters all pay the same).
 */
const LETTER_PAYS = Object.freeze([0.08, 0.16, 0.7]);
const PAYTABLE = Object.freeze({
  [SYMBOLS.CROWN]: [1.4, 3.0, 6],
  [SYMBOLS.FISH]: [0.35, 1.4, 3.0],
  [SYMBOLS.PEARL]: [0.28, 0.7, 2.0],
  [SYMBOLS.STARFISH]: [0.2, 0.3, 1.5],
  [SYMBOLS.CORAL]: [0.15, 0.2, 1.2],
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
const BASE_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 9],
  [SYMBOLS.N, 9],
  [SYMBOLS.E, 9],
  [SYMBOLS.A, 9],
  [SYMBOLS.STARFISH, 9.5],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 8],
  [SYMBOLS.CROWN, 6],
  [SYMBOLS.PEARL, 5],
  ["mult", 1.0],
]);

/** Free spins: plaques rain noticeably more often. */
const BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 9],
  [SYMBOLS.N, 9],
  [SYMBOLS.E, 9],
  [SYMBOLS.A, 9],
  [SYMBOLS.STARFISH, 9.5],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 8],
  [SYMBOLS.CROWN, 6],
  [SYMBOLS.PEARL, 5],
  ["mult", 2.95],
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
