const economy = require("../utils/slotEconomy");
/**
 * Poseidon – The God of Atlantis — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows. Scatter-pays: 7+ matching symbols
 * anywhere on screen pay, winners explode and symbols tumble in until no new
 * win forms (cascade continues while any type still has 7+). Multiplier
 * plaques (x2 → x1000) stay on screen for the whole tumbling sequence; when
 * the sequence ends with a win, their sum multiplies it. Base game is
 * per-spin. During free spins, plaques from winning spins bank into a
 * session total activated by fresh plaques on a win (losing spins do not add).
 * The character-head scatter is the free-spins trigger: 4+ heads in the base
 * game award 10 free spins; during free spins 3+ heads add 5 more. Multiplier
 * plaques only multiply wins — they never open the bonus.
 *
 * RTP was originally tuned for MIN_MATCH=8; lowering to 7 raises hit rate.
 * Re-tune with the seeded sim in test/poseidon.test.js if needed.
 */

const ECONOMY_VERSION = 3;
const JACKPOT_APPEARANCE_PROBABILITY = 0.18;
const JACKPOT_WIN_PROBABILITY = 0.0001;
const NATURAL_BONUS_PROBABILITY = 0.004;
const JACKPOT_MIN_SYMBOLS = 3;

const REEL_COUNT = 6;
const ROW_COUNT = 5;

const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MAX_WIN_MULTIPLIER = 5000;
const MIN_MATCH = 8;

/** 4+ character-head scatters in the base game trigger free spins. */
const TRIGGER_NATURAL_MIN = 4;
/** 3+ heads during free spins (incl. bought bonus) award +5 spins. */
const TRIGGER_RETRIGGER_MIN = 3;
/** Reel id for the Poseidon-head bonus scatter. */
const SCATTER = "head";
/** Visible often enough that 4-of-a-kind is reachable, not a once-a-session ghost. */
const HEAD_WEIGHT_BASE = 1.0;
const HEAD_WEIGHT_BONUS = 1.7;
/** @deprecated use TRIGGER_NATURAL_MIN / TRIGGER_RETRIGGER_MIN */
const TRIGGER_MIN_MULTIPLIERS = TRIGGER_RETRIGGER_MIN;
const FREE_SPINS_NATURAL = 10;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;

/** Buy bonus: 10 free spins, cost in bet multiples (EV-matched by sim). */
/**
 * Bonus prices are derived from the measured average return of a round, so a
 * purchase sits at the same RTP as an ordinary spin. Re-derive both with
 * `node tool/atlantisRtp.js` after any change to the paytable, the symbol
 * weights, the plaque rate, or MIN_MATCH.
 */
const BUY_BONUS_COST = 25;
/** Super buy bonus — 3× standard cost (UI tier). */
const SUPER_BUY_BONUS_COST = 250;

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

/** Base-game plaque value weights — generous hit rate and exciting multipliers. */
const BASE_MULTIPLIER_WEIGHTS = Object.freeze([24, 6, 0.8, 0.15, 0.04, 0.01, 0.005, 0.002, 0.001]);

/** Buy-bonus / free-spins — calibrated weights. */
const BONUS_MULTIPLIER_WEIGHTS = Object.freeze([18, 10, 4, 1.2, 0.4, 0.15, 0.05, 0.01, 0.005]);

/** Super buy-bonus multiplier weights (min x20). */
const SUPER_MULTIPLIER_WEIGHTS = Object.freeze([0, 0, 0, 30, 18, 10, 5, 2.5, 1]);

/**
 * When a mid/big plaque (x20+) is already on screen, further draws retain
 * the same published probabilities (no stacking suppression).
 */
const SUPPRESSED_MULTIPLIER_WEIGHTS = BASE_MULTIPLIER_WEIGHTS;

/** @deprecated kept for any external reads — prefer BASE/BONUS_MULTIPLIER_WEIGHTS */
const MULTIPLIER_GATES = Object.freeze([
  0.48, 0.35, 0.33, 0.32, 0.35, 0.4, 0.4, 0.35, 0.4,
]);

/** Plaques at/above this count as "big" for stacking suppression. */
const BIG_MULTIPLIER_THRESHOLD = 20;
/** Super buy-bonus: every plaque face (win or lose) is at least this. */
const SUPER_MULTIPLIER_MIN = 20;

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

/**
 * Plaques only bank on a winning spin.
 * Base: this spin's plaques multiply the win.
 * Bonus: banked total + this spin's plaques (if win) multiplies the win, and
 * that total carries forward, but applies only on wins with fresh plaques.
 */
function resolvePayoutMultiplier({
  baseWin = 0,
  plaqueSum = 0,
  carried = 0,
  isFreeSpin = false,
  bankCap = Infinity,
} = {}) {
  const win = Number(baseWin) > 0;
  const plaques = win ? Math.max(0, Number(plaqueSum) || 0) : 0;
  const prev = Math.max(0, Number(carried) || 0);
  const nextCarried = isFreeSpin
    ? Math.min(Number.isFinite(bankCap) ? bankCap : Infinity, prev + plaques)
    : 0;
  // Keep the bank, but require a new plaque on this winning spin to activate it.
  const pool = isFreeSpin ? nextCarried : plaques;
  const applied = win && plaques > 0 && pool > 0 ? pool : 1;
  return { applied, nextCarried, plaques };
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
 * Anywhere-pays pay rules and paytable in bet multiples (Zeus v3 clone).
 * Payout increases for every matching symbol above 8.
 * Ranking: crown > fish > pearl > starfish > coral > letters (A, E, N, S).
 */
const PAY_RULES = Object.freeze({
  [SYMBOLS.A]: Object.freeze({ start: 0.8, increment: 0.1 }),
  [SYMBOLS.E]: Object.freeze({ start: 0.8, increment: 0.1 }),
  [SYMBOLS.N]: Object.freeze({ start: 0.8, increment: 0.1 }),
  [SYMBOLS.S]: Object.freeze({ start: 0.8, increment: 0.1 }),
  [SYMBOLS.CORAL]: Object.freeze({ start: 1.1, increment: 0.2 }),
  [SYMBOLS.STARFISH]: Object.freeze({ start: 1.2, increment: 0.25 }),
  [SYMBOLS.PEARL]: Object.freeze({ start: 1.4, increment: 0.35 }),
  [SYMBOLS.FISH]: Object.freeze({ start: 1.6, increment: 0.4 }),
  [SYMBOLS.CROWN]: Object.freeze({ start: 2.0, increment: 0.5 }),
});

function payoutFor(symbol, count) {
  const rule = PAY_RULES[symbol];
  if (!rule || !Number.isInteger(count) || count < MIN_MATCH) return 0;
  return Math.round((rule.start + (count - MIN_MATCH) * rule.increment) * 10000) / 10000;
}

const PAYTABLE = Object.freeze(Object.fromEntries(
  Object.keys(PAY_RULES).map(symbol => [
    symbol,
    Object.freeze([
      payoutFor(symbol, 8),
      payoutFor(symbol, 10),
      payoutFor(symbol, 12),
    ]),
  ])
));

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
  [SYMBOLS.S, 11],
  [SYMBOLS.N, 11],
  [SYMBOLS.E, 11],
  [SYMBOLS.A, 11],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 7.5],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 5],
  ["mult", 2.8],
  [SCATTER, HEAD_WEIGHT_BASE],
  ["jackpot", 0.25],
]);

/**
 * When a plaque is already on screen, only this share of otherwise-winning
 * boards is allowed to pay. The rest are dealt below the match minimum so the
 * player still sees the multiplier art, but those spins win less often.
 */
const PLAQUE_WIN_KEEP = 0.5;

/** Free spins: plaques show even more often; high faces stay rare for RTP. */
const BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 13],
  [SYMBOLS.N, 13],
  [SYMBOLS.E, 13],
  [SYMBOLS.A, 13],
  [SYMBOLS.STARFISH, 8],
  [SYMBOLS.CORAL, 8],
  [SYMBOLS.FISH, 6],
  [SYMBOLS.CROWN, 4.5],
  [SYMBOLS.PEARL, 4],
  ["mult", 4],
  [SCATTER, HEAD_WEIGHT_BONUS],
  ["jackpot", 0.25],
]);

/** Win presentation tiers in bet multiples (client shows matching banner). */
const WIN_TIERS = Object.freeze([
  ["jackpot", 250],
  ["grand", 100],
  ["mega", 50],
  ["super", 25],
]);

function isScatter(cell) {
  return cell === SCATTER;
}

function isMultiplier(cell) {
  return typeof cell === "string" && cell.charCodeAt(0) === 120 /* 'x' */;
}

function multiplierValue(cell) {
  return isMultiplier(cell) ? Number(cell.slice(1)) : 0;
}


/** Bought spins pay a smaller cluster; the plaque bank is the bonus.
 *  Uncapped plaque sums need a smaller cluster or a ×100 snowballs the buy. */
const BONUS_CLUSTER_SCALE = 0.11;
// Full plaque sum. No bank ceiling. The round is still bounded by
// MAX_WIN_MULTIPLIER × bet.
const BONUS_BANK_CAP = Number.POSITIVE_INFINITY;
const SUPER_BONUS_BANK_CAP = Number.POSITIVE_INFINITY;

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
  ECONOMY_VERSION,
  JACKPOT_APPEARANCE_PROBABILITY,
  JACKPOT_WIN_PROBABILITY,
  NATURAL_BONUS_PROBABILITY,
  JACKPOT_MIN_SYMBOLS,
  SUPER_MULTIPLIER_WEIGHTS,
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
  SCATTER,
  HEAD_WEIGHT_BASE,
  HEAD_WEIGHT_BONUS,
  MULTIPLIER_VALUES,
  MULTIPLIER_GATES,
  BASE_MULTIPLIER_WEIGHTS,
  BONUS_MULTIPLIER_WEIGHTS,
  SUPPRESSED_MULTIPLIER_WEIGHTS,
  BIG_MULTIPLIER_THRESHOLD,
  SUPER_MULTIPLIER_MIN,
  APPLIED_MULTIPLIER_CAP_BASE,
  APPLIED_MULTIPLIER_CAP_BONUS,
  appliedMultiplierFor,
  resolvePayoutMultiplier,
  PAYING_SYMBOLS,
  PAY_RULES,
  PAYTABLE,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  PLAQUE_WIN_KEEP,
  BONUS_CLUSTER_SCALE,
  BONUS_BANK_CAP,
  SUPER_BONUS_BANK_CAP,
  WIN_TIERS,
  MIN_MATCH,
  isScatter,
  isMultiplier,
  multiplierValue,
  payoutFor,
  winTierFor,
  roundMoney,
};
