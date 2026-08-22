const crypto = require("crypto");
const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  WILD_REELS,
  WILD_ROW,
  MAIN_WILD_MULTIPLIERS,
  BONUS_WILD_MULTIPLIERS,
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
 *
 * Normal stops retain their existing weights and ordering.  A one-jackpot
 * stop is available only on a 1-in-N activation roll; windows containing two
 * or more jackpot cells are never eligible.  This prevents a single reel
 * from manufacturing most of a 3-symbol jackpot trigger.
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

  // Golden Tree's configured strips always have normal stops.  Keep the
  // original generic picker as a defensive fallback for malformed strips.
  if (normalStops.length === 0) return pickColumnWindow(strip, rng);

  const activateJackpot =
    singleJackpotStops.length > 0 &&
    rng(JACKPOT_WINDOW_ACTIVATION_ODDS) === 0;

  let eligibleStops = normalStops;
  if (activateJackpot) {
    // Keep jackpot stop share ~stable as wild-dense strips grow more
    // mixed normal windows (otherwise bonus jackpot rate collapses to ~0).
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

function assignWildMultipliers(matrix, multiplierPool, rng = secureRandomInt) {
  const wildMultipliers = {};
  for (const col of WILD_REELS) {
    if (matrix[col][WILD_ROW] === SYMBOLS.WILD) {
      wildMultipliers[col] = pickFromArray(multiplierPool, rng);
    }
  }
  return wildMultipliers;
}

/**
 * Generate a 5×3 outcome matrix.
 * Bonus mode uses denser (isolated) wild stops so trees appear often;
 * still never injects or guarantees a tree on every spin.
 * @returns {{ matrix: string[][], wildMultipliers: Record<number, number>, stopIndices: number[] }}
 */
function generateSpin({ bonusMode = false, rng = secureRandomInt } = {}) {
  const strips = bonusMode ? BONUS_REEL_STRIPS : MAIN_REEL_STRIPS;
  const multiplierPool = bonusMode ? BONUS_WILD_MULTIPLIERS : MAIN_WILD_MULTIPLIERS;

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
  const wildMultipliers = assignWildMultipliers(matrix, multiplierPool, rng);

  return { matrix, wildMultipliers, stopIndices };
}

module.exports = {
  generateSpin,
  windowAtStop,
  secureRandomInt,
  pickFromArray,
  pickColumnWindow,
  pickRareJackpotColumnWindow,
  sanitizeWildPlacements,
};
