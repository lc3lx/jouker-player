/**
 * Poseidon – The God of Atlantis — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows. Scatter-pays: 8+ matching symbols
 * anywhere on screen pay, winners explode and symbols tumble in until no new
 * win forms. Multiplier plaques stay on screen for the whole tumbling
 * sequence and their sum multiplies the sequence win. During free spins the
 * multiplier accumulates for the session (Gates-style).
 *
 * Simulated math (400k spins, seeded): RTP 95.2% (base 71.0% + scatter 0.9%
 * + bonus 23.3%), hit rate 30%, free spins ~1/380 worth ~88× bet.
 * Re-tune with the simulation in test/poseidon.test.js if weights change.
 */

const REEL_COUNT = 6;
const ROW_COUNT = 5;

const BET_MIN = 10000;
const BET_MAX = 40000000;
const MAX_WIN_MULTIPLIER = 5000;

const FREE_SPINS_AWARD = 15;
const RETRIGGER_AWARD = 5;
const TRIGGER_MIN_SCATTERS = 4;
const RETRIGGER_MIN_SCATTERS = 3;

/** Buy bonus costs 100× current bet and force-triggers the free spins. */
const BUY_BONUS_COST = 100;

const SYMBOLS = Object.freeze({
  // low pays (royals)
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
  // specials
  ORB: "orb", // scatter — triggers free spins, never removed by tumbles
});

/** Multiplier plaques are encoded straight into the matrix as `x<value>`. */
const MULTIPLIER_VALUES = Object.freeze([2, 5, 10, 20, 50]);
const MULTIPLIER_WEIGHTS = Object.freeze([50, 25, 13, 8, 4]);

const PAYING_SYMBOLS = Object.freeze([
  SYMBOLS.PEARL,
  SYMBOLS.CROWN,
  SYMBOLS.FISH,
  SYMBOLS.CORAL,
  SYMBOLS.STARFISH,
  SYMBOLS.A,
  SYMBOLS.E,
  SYMBOLS.N,
  SYMBOLS.S,
]);

/**
 * Anywhere-pays paytable in bet multiples.
 * Bands: 8–9 matches / 10–11 matches / 12+ matches.
 */
const PAYTABLE = Object.freeze({
  [SYMBOLS.PEARL]: [10, 25, 50],
  [SYMBOLS.CROWN]: [2.5, 10, 25],
  [SYMBOLS.FISH]: [2, 5, 15],
  [SYMBOLS.CORAL]: [1.3, 2, 12],
  [SYMBOLS.STARFISH]: [1, 1.6, 10],
  [SYMBOLS.A]: [0.8, 1.5, 8],
  [SYMBOLS.E]: [0.6, 1.2, 5],
  [SYMBOLS.N]: [0.4, 1, 4],
  [SYMBOLS.S]: [0.2, 0.75, 2],
});

/** Scatter pays in bet multiples by orb count (6+ uses the last band). */
const SCATTER_PAY = Object.freeze({ 4: 3, 5: 5, 6: 100 });

/**
 * Per-cell draw weights. Independent weighted draws per cell (not physical
 * strips) — RTP is enforced by simulation in test/poseidon.test.js.
 */
const BASE_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 15],
  [SYMBOLS.N, 14],
  [SYMBOLS.E, 13],
  [SYMBOLS.A, 12],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 8],
  [SYMBOLS.FISH, 7],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 4],
  [SYMBOLS.ORB, 1.75],
  ["mult", 0.55],
]);

/** Free spins: multiplier plaques rain noticeably more often. */
const BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 15],
  [SYMBOLS.N, 14],
  [SYMBOLS.E, 13],
  [SYMBOLS.A, 12],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 8],
  [SYMBOLS.FISH, 7],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 4],
  [SYMBOLS.ORB, 1.15],
  ["mult", 3.7],
]);

/** Tumble refills never introduce new scatters (trigger = what the drop dealt). */
const REFILL_EXCLUDES = new Set([SYMBOLS.ORB]);

/** Win presentation tiers in bet multiples (client shows matching banner). */
const WIN_TIERS = Object.freeze([
  ["jackpot", 250],
  ["grand", 100],
  ["mega", 50],
  ["super", 25],
]);

const MIN_MATCH = 8;

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

function scatterPayFor(count) {
  if (count >= 6) return SCATTER_PAY[6];
  return SCATTER_PAY[count] || 0;
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
  FREE_SPINS_AWARD,
  RETRIGGER_AWARD,
  TRIGGER_MIN_SCATTERS,
  RETRIGGER_MIN_SCATTERS,
  BUY_BONUS_COST,
  SYMBOLS,
  MULTIPLIER_VALUES,
  MULTIPLIER_WEIGHTS,
  PAYING_SYMBOLS,
  PAYTABLE,
  SCATTER_PAY,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  REFILL_EXCLUDES,
  WIN_TIERS,
  MIN_MATCH,
  isMultiplier,
  multiplierValue,
  payoutFor,
  scatterPayFor,
  winTierFor,
  roundMoney,
};
