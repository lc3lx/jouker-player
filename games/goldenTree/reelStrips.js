/**
 * Reel-strip weight configuration targeting ~96.49% theoretical RTP (medium volatility).
 *
 * Each reel strip is a cyclic array of symbols. A spin picks one stop index per reel;
 * the visible 3-row window is [stop-1, stop, stop+1] with wrap-around.
 *
 * Tune symbol frequencies here and re-run `node --test test/goldenTree.test.js` RTP probe.
 */

const { SYMBOLS, WILD_REELS, STAR_REELS } = require("./constants");

// A Golden Tree reel exposes three adjacent cells at once. Keep exactly one
// physical jackpot stop on each reel so a single reel can never contribute a
// cluster of jackpot scatters. `spinEngine` then activates those stops only
// one time in six, which puts the 3+ trigger slightly below Zeus' rate.
const JACKPOT_REEL_WEIGHT = 1;
const JACKPOT_WINDOW_ACTIVATION_ODDS = 6;

function buildStrip(entries) {
  const strip = [];
  for (const [symbol, weight] of entries) {
    for (let i = 0; i < weight; i += 1) {
      strip.push(symbol);
    }
  }
  return strip;
}

/** Base symbol mix shared by non-special reels. */
const BASE_MIX = [
  [SYMBOLS.CHERRY, 12],
  [SYMBOLS.ORANGE, 12],
  [SYMBOLS.PINEAPPLE, 12],
  [SYMBOLS.PLUM, 12],
  [SYMBOLS.BANANA, 14],
  [SYMBOLS.GRAPES, 9],
  [SYMBOLS.WATERMELON, 9],
  [SYMBOLS.BELL, 7],
  [SYMBOLS.SEVEN, 4],
  [SYMBOLS.DOLLAR, 3],
];

function stripForReel(reelIndex, mode) {
  const mix = BASE_MIX.map(([sym, w]) => [sym, w]);

  if (STAR_REELS.has(reelIndex)) {
    mix.push([SYMBOLS.STAR, 4]);
  }

  if (WILD_REELS.has(reelIndex)) {
    // Bonus spins make trees more frequent, but trees still land randomly;
    // bought bonuses never inject or guarantee them.
    const wildWeight = mode === "bonus" ? 10 : 1;
    mix.push([SYMBOLS.WILD, wildWeight]);
  }

  // Match-3 jackpot scatter (Zeus / Atlantis style) — all reels, low weight.
  mix.push([SYMBOLS.JACKPOT, JACKPOT_REEL_WEIGHT]);

  return buildStrip(mix);
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
  JACKPOT_REEL_WEIGHT,
  JACKPOT_WINDOW_ACTIVATION_ODDS,
};
