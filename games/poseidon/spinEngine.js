/**
 * Poseidon spin engine — generates the drop and resolves the entire tumbling
 * sequence server-side. The client only replays the presentation.
 *
 * Matrix layout: matrix[col][row], row 0 = top. All win amounts here are bet
 * multiples; poseidonService converts them to coins.
 */

const crypto = require("crypto");
const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  REFILL_EXCLUDES,
  MULTIPLIER_VALUES,
  MULTIPLIER_WEIGHTS,
} = require("./constants");
const { findWins, countScatters, collectMultipliers } = require("./winCalculator");

/** Hard stop — a legit sequence exhausts long before this. */
const MAX_TUMBLES = 40;

function secureRandom() {
  // crypto.randomInt range is capped at 2^48 - 1; 2^32 resolution is plenty.
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function secureRandomInt(maxExclusive) {
  return crypto.randomInt(0, maxExclusive);
}

function buildPicker(weightTable, rng, { excludes } = {}) {
  const entries = excludes
    ? weightTable.filter(([symbol]) => !excludes.has(symbol))
    : [...weightTable];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  return () => {
    let roll = rng() * total;
    for (const [symbol, weight] of entries) {
      roll -= weight;
      if (roll < 0) return symbol;
    }
    return entries[entries.length - 1][0];
  };
}

function pickMultiplierValue(rng) {
  const total = MULTIPLIER_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < MULTIPLIER_VALUES.length; i += 1) {
    roll -= MULTIPLIER_WEIGHTS[i];
    if (roll < 0) return MULTIPLIER_VALUES[i];
  }
  return MULTIPLIER_VALUES[0];
}

/** Draw one cell; "mult" placeholder resolves to a concrete `x<value>`. */
function drawCell(pick, rng) {
  const symbol = pick();
  return symbol === "mult" ? `x${pickMultiplierValue(rng)}` : symbol;
}

function generateGrid(weights, rng, { forceScatters = 0 } = {}) {
  const pickAny = buildPicker(weights, rng);
  const pickNoOrb = buildPicker(weights, rng, { excludes: REFILL_EXCLUDES });

  const matrix = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const column = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      column.push(drawCell(forceScatters > 0 ? pickNoOrb : pickAny, rng));
    }
    matrix.push(column);
  }

  if (forceScatters > 0) {
    // Spread the guaranteed orbs across distinct columns for a natural look.
    const cols = [...Array(REEL_COUNT).keys()];
    for (let i = cols.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [cols[i], cols[j]] = [cols[j], cols[i]];
    }
    for (let k = 0; k < Math.min(forceScatters, REEL_COUNT); k += 1) {
      matrix[cols[k]][Math.floor(rng() * ROW_COUNT)] = SYMBOLS.ORB;
    }
  }

  return matrix;
}

/**
 * Remove the given positions, slide survivors down, refill from the top.
 * Returns { matrix, refills } where refills[col] lists new symbols top-down.
 */
function tumble(matrix, removedPositions, pickRefill, rng) {
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const next = [];
  const refills = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const survivors = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (!removed.has(`${col}:${row}`)) survivors.push(matrix[col][row]);
    }
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      incoming.push(drawCell(pickRefill, rng));
    }
    refills.push(incoming);
    next.push([...incoming, ...survivors]);
  }
  return { matrix: next, refills };
}

/**
 * Resolve one full spin.
 *
 * Returns bet-multiple amounts:
 * {
 *   initialMatrix, finalMatrix,
 *   steps: [{ wins, stepWin, removedPositions, refills, matrixAfter }],
 *   baseWin,          // sum of tumble step wins, before any multiplier
 *   multipliers,      // plaques on the final screen [{col,row,value}]
 *   multiplierSum,
 *   scatterCount,
 * }
 */
function resolveSpin({ bonusMode = false, forceScatters = 0, rng = secureRandom } = {}) {
  const weights = bonusMode ? BONUS_WEIGHTS : BASE_WEIGHTS;
  const pickRefill = buildPicker(weights, rng, { excludes: REFILL_EXCLUDES });

  let matrix = generateGrid(weights, rng, { forceScatters });
  const initialMatrix = matrix.map((col) => [...col]);

  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(matrix);
    if (wins.length === 0) break;

    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const removedPositions = wins.flatMap((w) => w.positions);
    const result = tumble(matrix, removedPositions, pickRefill, rng);
    matrix = result.matrix;

    steps.push({
      wins,
      stepWin,
      removedPositions,
      refills: result.refills,
      matrixAfter: matrix.map((col) => [...col]),
    });
  }

  const multipliers = collectMultipliers(matrix);
  return {
    initialMatrix,
    finalMatrix: matrix,
    steps,
    baseWin,
    multipliers,
    multiplierSum: multipliers.reduce((sum, m) => sum + m.value, 0),
    scatterCount: countScatters(matrix),
  };
}

module.exports = {
  resolveSpin,
  generateGrid,
  tumble,
  secureRandom,
  secureRandomInt,
};
