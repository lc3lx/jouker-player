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
  BASE_MULTIPLIER_WEIGHTS,
  BONUS_MULTIPLIER_WEIGHTS,
  SUPPRESSED_MULTIPLIER_WEIGHTS,
  BIG_MULTIPLIER_THRESHOLD,
  multiplierValue,
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

function pickFromWeights(weights, rng) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return MULTIPLIER_VALUES[i];
  }
  return MULTIPLIER_VALUES[0];
}

/**
 * Weighted plaque value. Bonus mode uses a richer table.
 * When [bigAlready] is true (x20+ already on the grid), further draws
 * collapse toward small plaques so huge stacks stay rare.
 */
function pickMultiplierValue(rng, { bonus = false, bigAlready = false } = {}) {
  if (bigAlready) return pickFromWeights(SUPPRESSED_MULTIPLIER_WEIGHTS, rng);
  return pickFromWeights(
    bonus ? BONUS_MULTIPLIER_WEIGHTS : BASE_MULTIPLIER_WEIGHTS,
    rng,
  );
}

function countBigMultipliers(matrix) {
  let n = 0;
  for (const col of matrix) {
    for (const cell of col) {
      if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) n += 1;
    }
  }
  return n;
}

function countBigInCells(cells) {
  let n = 0;
  for (const cell of cells) {
    if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) n += 1;
  }
  return n;
}

/** Draw one cell; "mult" placeholder resolves to a concrete `x<value>`. */
function drawCell(pick, rng, { bonus = false, bigAlready = false } = {}) {
  const symbol = pick();
  return symbol === "mult"
    ? `x${pickMultiplierValue(rng, { bonus, bigAlready })}`
    : symbol;
}

function generateGrid(pick, rng, { bonus = false } = {}) {
  const matrix = [];
  let bigAlready = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const column = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const cell = drawCell(pick, rng, {
        bonus,
        bigAlready: bigAlready > 0,
      });
      if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) bigAlready += 1;
      column.push(cell);
    }
    matrix.push(column);
  }
  return matrix;
}

/**
 * Remove the given positions, slide survivors down, refill from the top.
 * Returns { matrix, refills } where refills[col] lists new symbols top-down.
 */
function tumble(matrix, removedPositions, pick, rng, { bonus = false } = {}) {
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const next = [];
  const refills = [];
  // Count big plaques that survive the tumble before any refill.
  let bigSurvivors = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (removed.has(`${col}:${row}`)) continue;
      if (multiplierValue(matrix[col][row]) >= BIG_MULTIPLIER_THRESHOLD) {
        bigSurvivors += 1;
      }
    }
  }

  let bigSoFar = bigSurvivors;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const survivors = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (!removed.has(`${col}:${row}`)) survivors.push(matrix[col][row]);
    }
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      const cell = drawCell(pick, rng, {
        bonus,
        bigAlready: bigSoFar > 0,
      });
      if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) bigSoFar += 1;
      incoming.push(cell);
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
  const drawOpts = { bonus: bonusMode };

  let matrix = generateGrid(pick, rng, drawOpts);
  const initialMatrix = matrix.map((col) => [...col]);

  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(matrix);
    if (wins.length === 0) break;

    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const removedPositions = wins.flatMap((w) => w.positions);
    const result = tumble(matrix, removedPositions, pick, rng, drawOpts);
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
  countBigMultipliers,
  countBigInCells,
};
