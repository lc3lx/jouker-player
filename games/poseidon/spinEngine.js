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
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  MULTIPLIER_VALUES,
  MULTIPLIER_GATES,
} = require("./constants");
const { findWins, collectMultipliers } = require("./winCalculator");

/** Hard stop — a legit sequence exhausts long before this. */
const MAX_TUMBLES = 40;

function secureRandom() {
  // crypto.randomInt range is capped at 2^48 - 1; 2^32 resolution is plenty.
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function secureRandomInt(maxExclusive) {
  return crypto.randomInt(0, maxExclusive);
}

function buildPicker(weightTable, rng) {
  const entries = [...weightTable];
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

/**
 * Gate cascade: try x2 at 90%, on miss x5 at 70%, … x1000 at 0.5%.
 * Falls back to x2 if every gate misses (~0.2% of draws).
 */
function pickMultiplierValue(rng) {
  for (let i = 0; i < MULTIPLIER_VALUES.length; i += 1) {
    if (rng() < MULTIPLIER_GATES[i]) return MULTIPLIER_VALUES[i];
  }
  return MULTIPLIER_VALUES[0];
}

/** Draw one cell; "mult" placeholder resolves to a concrete `x<value>`. */
function drawCell(pick, rng) {
  const symbol = pick();
  return symbol === "mult" ? `x${pickMultiplierValue(rng)}` : symbol;
}

function generateGrid(pick, rng) {
  const matrix = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const column = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      column.push(drawCell(pick, rng));
    }
    matrix.push(column);
  }
  return matrix;
}

/**
 * Remove the given positions, slide survivors down, refill from the top.
 * Returns { matrix, refills } where refills[col] lists new symbols top-down.
 */
function tumble(matrix, removedPositions, pick, rng) {
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
      incoming.push(drawCell(pick, rng));
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
 * }
 */
function resolveSpin({ bonusMode = false, rng = secureRandom } = {}) {
  const weights = bonusMode ? BONUS_WEIGHTS : BASE_WEIGHTS;
  const pick = buildPicker(weights, rng);

  let matrix = generateGrid(pick, rng);
  const initialMatrix = matrix.map((col) => [...col]);

  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(matrix);
    if (wins.length === 0) break;

    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const removedPositions = wins.flatMap((w) => w.positions);
    const result = tumble(matrix, removedPositions, pick, rng);
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
  };
}

module.exports = {
  resolveSpin,
  generateGrid,
  tumble,
  pickMultiplierValue,
  secureRandom,
  secureRandomInt,
};
