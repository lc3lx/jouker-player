/**
 * Poseidon – The God of Atlantis — core game constants.
 *
 * Matrix: 6 reels (columns) × 5 rows. Scatter-pays: 8+ matching symbols
 * anywhere on screen pay, winners explode and symbols tumble in until no new
 * win forms. Multiplier plaques (x2 → x1000) stay on screen for the whole
 * tumbling sequence; when the sequence ends with a win, their sum multiplies
 * it — in the base game AND in free spins (per-spin, no accumulation).
 * Plaques are also the free-spins trigger: 3+ on screen award free spins.
 *
 * Simulated math (400k spins, seeded): RTP 93.0% (base 84.3% + free spins
 * 8.7%), hit rate 31.8%, trigger ~1/152, buy bonus EV 28.5× vs 30× cost
 * (buy RTP 95.2%). Plaque value distribution matches the design spec:
 * x2 90.2%, x5 7.0%, x10 1.8%, … x1000 ~0.002%. Multipliers land on 32% of
 * spins; ~35% of those coincide with a win (rest are wasted, by design).
 * Re-tune with the seeded sim in test/poseidon.test.js if weights change.
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
 * Value selection is a gate cascade with the designer's literal percentages:
 * roll x2 at 90% — on miss roll x5 at 70% — … — x1000 at 0.5%; if every gate
 * misses, fall back to x2. So x2 appears ~90% of the time, and each higher
 * value gets progressively rarer (plaque EV ≈ 2.9× bet-multiplier units).
 */
const MULTIPLIER_VALUES = Object.freeze([2, 5, 10, 20, 50, 100, 200, 500, 1000]);
const MULTIPLIER_GATES = Object.freeze([
  0.9, 0.7, 0.6, 0.4, 0.35, 0.3, 0.2, 0.1, 0.005,
]);

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
 * Bands: 8–9 matches / 10–11 matches / 12+ matches.
 * Ranking per design: crown > fish > pearl > starfish > coral > letters
 * (letters all pay the same).
 */
const LETTER_PAYS = Object.freeze([0.6, 1.2, 5]);
const PAYTABLE = Object.freeze({
  [SYMBOLS.CROWN]: [12, 30, 60],
  [SYMBOLS.FISH]: [3, 12, 30],
  [SYMBOLS.PEARL]: [2.5, 6, 18],
  [SYMBOLS.STARFISH]: [2, 2.5, 15],
  [SYMBOLS.CORAL]: [1.5, 2, 12],
  [SYMBOLS.A]: LETTER_PAYS,
  [SYMBOLS.E]: LETTER_PAYS,
  [SYMBOLS.N]: LETTER_PAYS,
  [SYMBOLS.S]: LETTER_PAYS,
});

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
  ["mult", 1.0],
]);

/** Free spins: plaques rain noticeably more often. */
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
  ["mult", 2.95],
]);

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
