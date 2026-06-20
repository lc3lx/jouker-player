const crypto = require("crypto");
const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  WILD_REELS,
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

/**
 * Place guaranteed wild reels by overwriting column with wild at a random anchor row,
 * then expanding to full column (handled downstream).
 */
function injectGuaranteedWilds(matrix, wildMultipliers, guaranteedCount, multiplierPool) {
  const pool = [...WILD_REELS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = secureRandomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const cols = pool.slice(0, Math.min(guaranteedCount, pool.length));
  for (const col of cols) {
    const anchorRow = secureRandomInt(ROW_COUNT);
    for (let row = 0; row < ROW_COUNT; row += 1) {
      matrix[col][row] = SYMBOLS.WILD;
    }
    wildMultipliers[col] = pickFromArray(multiplierPool);
    void anchorRow;
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
  const wildMultipliers = {};
  const stopIndices = [];

  for (let col = 0; col < REEL_COUNT; col += 1) {
    const strip = strips[col];
    const stop = secureRandomInt(strip.length);
    stopIndices.push(stop);
    const column = windowAtStop(strip, stop);
    for (let row = 0; row < ROW_COUNT; row += 1) {
      matrix[col][row] = column[row];
    }
    if (column.includes(SYMBOLS.WILD)) {
      wildMultipliers[col] = pickFromArray(multiplierPool);
    }
  }

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
};
