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
const { MAIN_REEL_STRIPS, BONUS_REEL_STRIPS } = require("./reelStrips");

/**
 * Cryptographically secure RNG — never trust client-side randomness.
 */
function secureRandomInt(max) {
  if (max <= 0) return 0;
  return crypto.randomInt(0, max);
}

function pickFromArray(arr) {
  return arr[secureRandomInt(arr.length)];
}

/**
 * Pick a visible 3-row window — resample when all three rows match
 * (plum/plum/plum columns) while keeping strip weights / RTP intact.
 */
function pickColumnWindow(strip) {
  const len = strip.length;
  let stop = secureRandomInt(len);
  let column = windowAtStop(strip, stop);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (column[0] !== column[1] || column[1] !== column[2]) {
      return { column, stop };
    }
    stop = secureRandomInt(len);
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

function assignWildMultipliers(matrix, multiplierPool) {
  const wildMultipliers = {};
  for (const col of WILD_REELS) {
    if (matrix[col][WILD_ROW] === SYMBOLS.WILD) {
      wildMultipliers[col] = pickFromArray(multiplierPool);
    }
  }
  return wildMultipliers;
}

/**
 * Place guaranteed wilds on the middle row of eligible reels only.
 */
function injectGuaranteedWilds(matrix, wildMultipliers, guaranteedCount, multiplierPool) {
  const pool = [...WILD_REELS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const cols = pool.slice(0, Math.min(guaranteedCount, pool.length));
  for (const col of cols) {
    matrix[col][WILD_ROW] = SYMBOLS.WILD;
    wildMultipliers[col] = pickFromArray(multiplierPool);
  }
}

/**
 * Generate a 5×3 outcome matrix.
 * @returns {{ matrix: string[][], wildMultipliers: Record<number, number>, stopIndices: number[] }}
 */
function generateSpin({ bonusMode = false, guaranteedWilds = 0 } = {}) {
  const strips = bonusMode ? BONUS_REEL_STRIPS : MAIN_REEL_STRIPS;
  const multiplierPool = bonusMode ? BONUS_WILD_MULTIPLIERS : MAIN_WILD_MULTIPLIERS;

  const matrix = Array.from({ length: REEL_COUNT }, () =>
    Array.from({ length: ROW_COUNT }, () => SYMBOLS.CHERRY),
  );
  const stopIndices = [];

  for (let col = 0; col < REEL_COUNT; col += 1) {
    const strip = strips[col];
    const { column, stop } = pickColumnWindow(strip);
    stopIndices.push(stop);
    for (let row = 0; row < ROW_COUNT; row += 1) {
      matrix[col][row] = column[row];
    }
  }

  sanitizeWildPlacements(matrix);
  const wildMultipliers = assignWildMultipliers(matrix, multiplierPool);

  if (guaranteedWilds > 0) {
    injectGuaranteedWilds(matrix, wildMultipliers, guaranteedWilds, multiplierPool);
  }

  return { matrix, wildMultipliers, stopIndices };
}

module.exports = {
  generateSpin,
  windowAtStop,
  secureRandomInt,
  pickFromArray,
  pickColumnWindow,
  sanitizeWildPlacements,
};
