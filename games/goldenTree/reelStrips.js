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

/** Main game: sparse middle-row trees on reels 2–4. */
const MAIN_WILD_COUNT = 1;
/**
 * Bonus / buy-bonus: frequent isolated trees (high chance, never guaranteed).
 * Wilds are placed by replacing fruit stops (strip length unchanged) so
 * jackpot rarity stays stable. Contiguous WWW clumps are avoided — the
 * mixed-column picker rejects them and collapses effective tree rate.
 */
const BONUS_WILD_COUNT = 26;

function buildStrip(entries) {
  const strip = [];
  for (const [symbol, weight] of entries) {
    for (let i = 0; i < weight; i += 1) {
      strip.push(symbol);
    }
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

/** Base symbol mix shared by non-special reels. */
const BASE_MIX = [
  // Extra low-fruit weight replaces removed dollar/star scatter stops.
  [SYMBOLS.CHERRY, 14],
  [SYMBOLS.ORANGE, 14],
  [SYMBOLS.PINEAPPLE, 14],
  [SYMBOLS.PLUM, 14],
  [SYMBOLS.BANANA, 20],
  [SYMBOLS.GRAPES, 9],
  [SYMBOLS.WATERMELON, 9],
  [SYMBOLS.BELL, 7],
  [SYMBOLS.SEVEN, 4],
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
