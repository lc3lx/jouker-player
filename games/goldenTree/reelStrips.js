/**
 * Reel-strip weight configuration targeting ~96.49% theoretical RTP (medium volatility).
 *
 * Each reel strip is a cyclic array of symbols. A spin picks one stop index per reel;
 * the visible 3-row window is [stop-1, stop, stop+1] with wrap-around.
 *
 * Tune symbol frequencies here and re-run `node --test test/goldenTree.test.js` RTP probe.
 */

const { SYMBOLS, WILD_REELS, STAR_REELS } = require("./constants");

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
  [SYMBOLS.CHERRY, 14],
  [SYMBOLS.ORANGE, 14],
  [SYMBOLS.LEMON, 14],
  [SYMBOLS.PLUM, 14],
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
    // Rare in main game — guaranteed wilds come from buy-bonus injection.
    const wildWeight = mode === "bonus" ? 10 : 2;
    mix.push([SYMBOLS.WILD, wildWeight]);
  }

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
};
