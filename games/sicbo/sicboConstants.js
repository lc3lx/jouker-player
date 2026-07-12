/**
 * Sic Bo — core game constants: bet catalog, corrected-standard odds, chip economy,
 * limits, and round phase timings.
 *
 * Odds are expressed as NET payout multipliers (winnings on top of the returned stake),
 * i.e. a winning "big" bet of 10000 returns 10000 stake + 10000 profit.
 *
 * Rules (corrected standard Sic Bo):
 *   - big/small/odd/even LOSE on any triple.
 *   - single die pays 1:1 / 2:1 / 3:1 by the number of matching dice.
 */

// ─── Economy (reuse slot ladder — MongoDB is source of truth) ────────────────
const BET_MIN = 10000;
const BET_MAX = 40000000;

/** Chip denominations shown in the betting rack (ascending). */
const CHIP_DENOMINATIONS = Object.freeze([
  10000, 20000, 50000, 100000, 500000, 1000000,
]);

/** Max total a single player may stake across ALL bets in one round. */
const MAX_ROUND_STAKE_PER_PLAYER = 200000000;

// ─── Round phase timings (env-overridable) ───────────────────────────────────
const BETTING_MS = clampInt(process.env.SICBO_BET_MS, 25000, 3000, 120000);
const RESULT_MS = clampInt(process.env.SICBO_RESULT_MS, 10000, 3000, 60000);

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ─── Round phases ────────────────────────────────────────────────────────────
const PHASE = Object.freeze({
  BETTING: "BETTING",
  LOCKED: "LOCKED",
  ROLLING: "ROLLING",
  RESULT: "RESULT",
  SETTLED: "SETTLED",
});

// ─── Bet type families ───────────────────────────────────────────────────────
const BET_FAMILY = Object.freeze({
  BIG: "big",
  SMALL: "small",
  ODD: "odd",
  EVEN: "even",
  TOTAL: "total", // total_4 .. total_17
  DOUBLE: "double", // double_1 .. double_6
  TRIPLE: "triple", // triple_1 .. triple_6 (specific)
  ANY_TRIPLE: "any_triple",
  COMBO: "combo", // combo_12 .. combo_56 (two distinct dice)
  SINGLE: "single", // single_1 .. single_6
});

/** Net multiplier for each three-dice total (standard Sic Bo). */
const TOTAL_ODDS = Object.freeze({
  4: 60,
  17: 60,
  5: 30,
  16: 30,
  6: 18,
  15: 18,
  7: 12,
  14: 12,
  8: 8,
  13: 8,
  9: 6,
  12: 6,
  10: 6,
  11: 6,
});

const ODDS = Object.freeze({
  BIG_SMALL: 1,
  ODD_EVEN: 1,
  DOUBLE: 10,
  TRIPLE_SPECIFIC: 180,
  ANY_TRIPLE: 30,
  COMBO: 5,
  SINGLE_PER_MATCH: 1, // 1:1 per matching die → up to 3:1
});

/** All valid two-dice combination pairs (i<j). */
const COMBO_PAIRS = (() => {
  const pairs = [];
  for (let i = 1; i <= 6; i += 1) {
    for (let j = i + 1; j <= 6; j += 1) pairs.push(`${i}${j}`);
  }
  return Object.freeze(pairs); // 15 combos
})();

/**
 * Build the full whitelist of valid bet type keys + their net odds.
 * @returns {Map<string, number>} betType → net multiplier
 */
function buildBetCatalog() {
  const cat = new Map();
  cat.set("big", ODDS.BIG_SMALL);
  cat.set("small", ODDS.BIG_SMALL);
  cat.set("odd", ODDS.ODD_EVEN);
  cat.set("even", ODDS.ODD_EVEN);
  for (let t = 4; t <= 17; t += 1) cat.set(`total_${t}`, TOTAL_ODDS[t]);
  for (let d = 1; d <= 6; d += 1) cat.set(`double_${d}`, ODDS.DOUBLE);
  for (let d = 1; d <= 6; d += 1) cat.set(`triple_${d}`, ODDS.TRIPLE_SPECIFIC);
  cat.set("any_triple", ODDS.ANY_TRIPLE);
  for (const p of COMBO_PAIRS) cat.set(`combo_${p}`, ODDS.COMBO);
  for (let d = 1; d <= 6; d += 1) cat.set(`single_${d}`, ODDS.SINGLE_PER_MATCH);
  return cat;
}

const BET_CATALOG = buildBetCatalog();

/** True when betType is a recognised Sic Bo bet. */
function isValidBetType(betType) {
  return BET_CATALOG.has(String(betType));
}

/** Net odds multiplier for a bet type, or 0 if unknown. */
function oddsFor(betType) {
  return BET_CATALOG.get(String(betType)) || 0;
}

/** True when amount is an allowed chip denomination (or a positive sum of chips ≥ BET_MIN). */
function isAllowedStake(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < BET_MIN || n > BET_MAX) return false;
  // Any positive multiple of the smallest chip is allowed (players stack chips).
  return n % CHIP_DENOMINATIONS[0] === 0;
}

module.exports = {
  BET_MIN,
  BET_MAX,
  CHIP_DENOMINATIONS,
  MAX_ROUND_STAKE_PER_PLAYER,
  BETTING_MS,
  RESULT_MS,
  PHASE,
  BET_FAMILY,
  TOTAL_ODDS,
  ODDS,
  COMBO_PAIRS,
  BET_CATALOG,
  isValidBetType,
  oddsFor,
  isAllowedStake,
};
