/**
 * Reel-strip weight configuration targeting ~96.49% theoretical RTP (medium volatility).
 *
 * Each reel strip is a cyclic array of symbols. A spin picks one stop index per reel;
 * the visible 3-row window is [stop-1, stop, stop+1] with wrap-around.
 *
 * Tune symbol frequencies here and re-run `node --test test/goldenTree.test.js` RTP probe.
 */

const { SYMBOLS, WILD_REELS } = require("./constants");

// A Golden Tree reel exposes three adjacent cells at once. Keep exactly one
// physical jackpot stop on each reel so a single reel can never contribute a
// cluster of jackpot scatters. `spinEngine` then activates those stops only
// one time in six, which puts the 3+ trigger slightly below Zeus' rate.
const JACKPOT_REEL_WEIGHT = 1;
const JACKPOT_WINDOW_ACTIVATION_ODDS = 6;

/**
 * Main game: middle-row trees on reels 2–4. The plain (×1) tree is the tier a
 * player meets most, so the base game needs enough of them to feel alive.
 */
const MAIN_WILD_COUNT = 10;
/**
 * Bonus / buy-bonus: trees that land on their own, on top of the count the
 * round forces. Wilds replace fruit stops (strip length unchanged) so jackpot
 * rarity stays stable, and `placeIsolatedWilds` keeps them non-adjacent.
 */
const BONUS_WILD_COUNT = 4;

/**
 * Lay the weighted symbols out evenly around the strip instead of in one solid
 * block each.
 *
 * A blocked strip (14 cherries, then 14 oranges, …) collapses the game: almost
 * every 3-row window falls inside a block, `pickColumnWindow` rejects it for
 * being uniform, and the handful of surviving stops sit on block boundaries —
 * one or two per symbol whatever its weight. The declared weights then mean
 * nothing and every symbol lands about equally often.
 *
 * Spreading them (largest-remainder: each slot goes to the symbol furthest
 * behind its ideal share) keeps the strip deterministic while making stop
 * frequency actually track weight.
 */
function buildStrip(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return [];

  const placed = entries.map(() => 0);
  const strip = [];

  for (let slot = 0; slot < total; slot += 1) {
    let bestIndex = 0;
    let bestDebt = -Infinity;
    for (let i = 0; i < entries.length; i += 1) {
      const [, weight] = entries[i];
      if (placed[i] >= weight) continue;
      // How far this symbol has fallen behind its ideal share by this slot.
      const debt = (slot + 1) * (weight / total) - placed[i];
      if (debt > bestDebt) {
        bestDebt = debt;
        bestIndex = i;
      }
    }
    strip.push(entries[bestIndex][0]);
    placed[bestIndex] += 1;
  }

  return strip;
}

/**
 * Replace fruit stops with isolated wilds (never adjacent, never on jackpot).
 * [reelIndex] offsets the pattern so wild reels do not lock-step together.
 */
function placeIsolatedWilds(baseStrip, count, reelIndex = 0) {
  if (count <= 0) return [...baseStrip];
  const out = [...baseStrip];
  const len = out.length;
  const candidates = [];

  for (let i = 0; i < len; i += 1) {
    if (out[i] === SYMBOLS.JACKPOT || out[i] === SYMBOLS.WILD) continue;
    candidates.push(i);
  }
  if (candidates.length === 0) return out;

  const start = (reelIndex * 11) % candidates.length;
  const step = Math.max(1, Math.floor(candidates.length / count));
  let placed = 0;

  for (let n = 0; n < candidates.length && placed < count; n += 1) {
    const idx = candidates[(start + n * step) % candidates.length];
    if (out[idx] === SYMBOLS.WILD || out[idx] === SYMBOLS.JACKPOT) continue;
    const left = out[(idx - 1 + len) % len];
    const right = out[(idx + 1) % len];
    if (left === SYMBOLS.WILD || right === SYMBOLS.WILD) continue;
    out[idx] = SYMBOLS.WILD;
    placed += 1;
  }

  return out;
}

/**
 * Base symbol mix shared by non-special reels.
 *
 * Low fruits carry most of the weight so three-in-a-row happens often enough to
 * carry the base game (~28% of spins land a win); the premium symbols stay thin
 * so their long runs keep their value.
 */
const BASE_MIX = [
  [SYMBOLS.CHERRY, 40],
  [SYMBOLS.ORANGE, 38],
  [SYMBOLS.PINEAPPLE, 36],
  [SYMBOLS.PLUM, 36],
  [SYMBOLS.BANANA, 42],
  [SYMBOLS.GRAPES, 7],
  [SYMBOLS.WATERMELON, 7],
  [SYMBOLS.BELL, 5],
  [SYMBOLS.SEVEN, 3],
];

function stripForReel(reelIndex, mode) {
  const mix = BASE_MIX.map(([sym, w]) => [sym, w]);
  // Match-3 jackpot scatter (Zeus / Atlantis style) — all reels, low weight.
  mix.push([SYMBOLS.JACKPOT, JACKPOT_REEL_WEIGHT]);

  let strip = buildStrip(mix);
  if (WILD_REELS.has(reelIndex)) {
    const wildCount = mode === "bonus" ? BONUS_WILD_COUNT : MAIN_WILD_COUNT;
    strip = placeIsolatedWilds(strip, wildCount, reelIndex);
  }
  return strip;
}

const MAIN_REEL_STRIPS = Array.from({ length: 5 }, (_, i) =>
  stripForReel(i, "main"),
);

const BONUS_REEL_STRIPS = Array.from({ length: 5 }, (_, i) =>
  stripForReel(i, "bonus"),
);

module.exports = {
  MAIN_REEL_STRIPS,
  BONUS_REEL_STRIPS,
  buildStrip,
  placeIsolatedWilds,
  JACKPOT_REEL_WEIGHT,
  JACKPOT_WINDOW_ACTIVATION_ODDS,
  MAIN_WILD_COUNT,
  BONUS_WILD_COUNT,
};
