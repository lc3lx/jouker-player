const crypto = require("crypto");
const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  WILD_REELS,
  WILD_ROW,
  MAIN_WILD_MULTIPLIER_WEIGHTS,
  BONUS_WILD_MULTIPLIER_WEIGHTS,
  BONUS_FORCED_TREE_WEIGHTS,
} = require("./constants");
const {
  MAIN_REEL_STRIPS,
  BONUS_REEL_STRIPS,
  JACKPOT_WINDOW_ACTIVATION_ODDS,
} = require("./reelStrips");

/**
 * Cryptographically secure RNG — never trust client-side randomness.
 */
function secureRandomInt(max) {
  if (max <= 0) return 0;
  return crypto.randomInt(0, max);
}

function pickFromArray(arr, rng = secureRandomInt) {
  return arr[rng(arr.length)];
}

/**
 * Pick one value from [value, weight] pairs — higher weight, more often.
 */
function weightedPick(entries, rng = secureRandomInt) {
  let total = 0;
  for (const [, weight] of entries) total += weight;
  if (total <= 0) return entries[0][0];

  let roll = rng(total);
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * Pick a visible 3-row window — resample when all three rows match
 * (plum/plum/plum columns) while keeping strip weights / RTP intact.
 */
function pickColumnWindow(strip, rng = secureRandomInt) {
  const len = strip.length;
  let stop = rng(len);
  let column = windowAtStop(strip, stop);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (column[0] !== column[1] || column[1] !== column[2]) {
      return { column, stop };
    }
    stop = rng(len);
    column = windowAtStop(strip, stop);
  }

  for (let offset = 1; offset < len; offset += 1) {
    const shifted = (stop + offset) % len;
    const candidate = windowAtStop(strip, shifted);
    if (candidate[0] !== candidate[1] || candidate[1] !== candidate[2]) {
      return { column: candidate, stop: shifted };
    }
  }

  return { column, stop };
}

function isMixedColumn(column) {
  return column[0] !== column[1] || column[1] !== column[2];
}

function jackpotCount(column) {
  return column.filter((symbol) => symbol === SYMBOLS.JACKPOT).length;
}

/**
 * Select a Golden Tree reel window while keeping jackpot scatters rare.
 */
function pickRareJackpotColumnWindow(strip, rng = secureRandomInt) {
  const normalStops = [];
  const singleJackpotStops = [];

  for (let stop = 0; stop < strip.length; stop += 1) {
    const column = windowAtStop(strip, stop);
    if (!isMixedColumn(column)) continue;

    const jackpots = jackpotCount(column);
    if (jackpots === 0) {
      normalStops.push(stop);
    } else if (jackpots === 1) {
      singleJackpotStops.push(stop);
    }
  }

  if (normalStops.length === 0) return pickColumnWindow(strip, rng);

  const activateJackpot =
    singleJackpotStops.length > 0 &&
    rng(JACKPOT_WINDOW_ACTIVATION_ODDS) === 0;

  let eligibleStops = normalStops;
  if (activateJackpot) {
    const targetShare = 0.15;
    const boost = Math.max(
      1,
      Math.round(
        (targetShare * normalStops.length) /
          ((1 - targetShare) * singleJackpotStops.length),
      ),
    );
    eligibleStops = normalStops.slice();
    for (let i = 0; i < boost; i += 1) {
      eligibleStops.push(...singleJackpotStops);
    }
  }

  const stop = eligibleStops[rng(eligibleStops.length)];

  return { column: windowAtStop(strip, stop), stop };
}

/**
 * Read 3 consecutive symbols from a cyclic reel strip at stopIndex.
 * Returns [row0, row1, row2] top → bottom.
 */
function windowAtStop(strip, stopIndex) {
  const len = strip.length;
  const top = strip[(stopIndex - 1 + len) % len];
  const mid = strip[stopIndex % len];
  const bot = strip[(stopIndex + 1) % len];
  return [top, mid, bot];
}

/** Wild trees only exist on reels 2–4 (0-based 1–3), middle row only. */
function sanitizeWildPlacements(matrix) {
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (matrix[col][row] !== SYMBOLS.WILD) continue;
      if (!WILD_REELS.has(col) || row !== WILD_ROW) {
        matrix[col][row] = SYMBOLS.CHERRY;
      }
    }
  }
}

/**
 * Force wild trees on columns 1, 2, 3 at middle row for buy bonus.
 * Columns 0 and 4 must NOT have trees (enforced by sanitizeWildPlacements).
 */
function forceTreesOnMiddleReels(matrix) {
  for (const col of WILD_REELS) {
    matrix[col][WILD_ROW] = SYMBOLS.WILD;
  }
}

/**
 * Plant exactly [count] trees on random wild reels, clearing the rest, so a
 * bonus spin can land anywhere from an empty board to the full triple.
 */
function placeForcedTrees(matrix, count, rng = secureRandomInt) {
  const reels = [...WILD_REELS];
  for (let i = reels.length - 1; i > 0; i -= 1) {
    const j = rng(i + 1);
    [reels[i], reels[j]] = [reels[j], reels[i]];
  }

  const planted = reels.slice(0, Math.max(0, Math.min(count, reels.length)));
  for (const col of reels) {
    const isTree = planted.includes(col);
    if (isTree) {
      matrix[col][WILD_ROW] = SYMBOLS.WILD;
    } else if (matrix[col][WILD_ROW] === SYMBOLS.WILD) {
      matrix[col][WILD_ROW] = SYMBOLS.CHERRY;
    }
  }
}

/** Roll how many trees a non-opening bonus spin gets (0–3). */
function pickForcedTreeCount(rng = secureRandomInt) {
  return weightedPick(BONUS_FORCED_TREE_WEIGHTS, rng);
}

function assignWildMultipliers(matrix, multiplierWeights, rng = secureRandomInt) {
  const wildMultipliers = {};
  for (const col of WILD_REELS) {
    if (matrix[col][WILD_ROW] === SYMBOLS.WILD) {
      wildMultipliers[col] = weightedPick(multiplierWeights, rng);
    }
  }
  return wildMultipliers;
}

/**
 * Generate a 5×3 outcome matrix.
 * [forceTrees] plants the full triple on columns 1, 2, 3 (buy bonus opening
 * spin). [forceTreeCount] instead plants exactly that many trees on random wild
 * reels — the luck roll for the rest of a bonus round.
 * @returns {{ matrix: string[][], wildMultipliers: Record<number, number>, stopIndices: number[] }}
 */
function generateSpin({
  bonusMode = false,
  forceTrees = false,
  forceTreeCount = null,
  rng = secureRandomInt,
} = {}) {
  const strips = bonusMode ? BONUS_REEL_STRIPS : MAIN_REEL_STRIPS;
  const multiplierWeights = bonusMode
    ? BONUS_WILD_MULTIPLIER_WEIGHTS
    : MAIN_WILD_MULTIPLIER_WEIGHTS;

  const matrix = Array.from({ length: REEL_COUNT }, () =>
    Array.from({ length: ROW_COUNT }, () => SYMBOLS.CHERRY),
  );
  const stopIndices = [];

  for (let col = 0; col < REEL_COUNT; col += 1) {
    const strip = strips[col];
    const { column, stop } = pickRareJackpotColumnWindow(strip, rng);
    stopIndices.push(stop);
    for (let row = 0; row < ROW_COUNT; row += 1) {
      matrix[col][row] = column[row];
    }
  }

  sanitizeWildPlacements(matrix);

  // Buy bonus opening spin: the full triple. Later bonus spins: a rolled count.
  if (forceTrees) {
    forceTreesOnMiddleReels(matrix);
  } else if (Number.isInteger(forceTreeCount)) {
    placeForcedTrees(matrix, forceTreeCount, rng);
  }

  const wildMultipliers = assignWildMultipliers(matrix, multiplierWeights, rng);

  return { matrix, wildMultipliers, stopIndices };
}

module.exports = {
  generateSpin,
  windowAtStop,
  secureRandomInt,
  pickFromArray,
  weightedPick,
  pickColumnWindow,
  pickRareJackpotColumnWindow,
  sanitizeWildPlacements,
  forceTreesOnMiddleReels,
  placeForcedTrees,
  pickForcedTreeCount,
};
