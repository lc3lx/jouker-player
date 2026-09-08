/**
 * Zenobia spin engine — deals the board and resolves the whole tumble sequence
 * server-side. The client only replays the presentation it is handed.
 *
 * Matrix layout: matrix[col][row], row 0 = top. Every amount here is a bet
 * multiple; zenobiaService converts to coins.
 *
 * Plaques and BONUS coins are never part of a winning route, so they are never
 * cleared by one — they ride the cascade down and stay on the board. That makes
 * the plaques on the final screen exactly the set that landed during the whole
 * sequence, which is what the Bonus Box banks. Each step still reports the
 * plaques its refill introduced so the client can fill the box as it tumbles.
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
  SUPER_MULTIPLIER_MIN,
  SCATTER,
  isMultiplier,
  multiplierValue,
} = require("./constants");
const {
  findWins,
  collectMultipliers,
  collectScatters,
} = require("./winCalculator");

/** Hard stop — a legitimate sequence exhausts long before this. */
const MAX_TUMBLES = 40;

function secureRandom() {
  // crypto.randomInt is capped at 2^48 - 1; 2^32 resolution is plenty here.
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

function pickFromWeights(weights, rng, values) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return values[i];
  }
  return values[0];
}

function plaqueTable({ bonus = false, bigAlready = false, superBonus = false } = {}) {
  const weights = bigAlready
    ? SUPPRESSED_MULTIPLIER_WEIGHTS
    : bonus || superBonus
      ? BONUS_MULTIPLIER_WEIGHTS
      : BASE_MULTIPLIER_WEIGHTS;
  if (!superBonus) return { values: MULTIPLIER_VALUES, weights };
  const start = MULTIPLIER_VALUES.findIndex((v) => v >= SUPER_MULTIPLIER_MIN);
  return {
    values: MULTIPLIER_VALUES.slice(start),
    weights: weights.slice(start),
  };
}

/**
 * Weighted plaque face. Free spins use a richer table, super buy-bonus never
 * deals below [SUPER_MULTIPLIER_MIN], and once a royal face is already on the
 * board further draws collapse toward the gold end.
 */
function pickMultiplierValue(rng, opts = {}) {
  const { values, weights } = plaqueTable(opts);
  return pickFromWeights(weights, rng, values);
}

/** Draw one cell; the "mult" placeholder resolves to a concrete `x<value>`. */
function drawCell(pick, rng, opts = {}) {
  const symbol = pick();
  return symbol === "mult" ? `x${pickMultiplierValue(rng, opts)}` : symbol;
}

function isBigPlaque(cell) {
  return multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD;
}

function countBigMultipliers(matrix) {
  let n = 0;
  for (const col of matrix) {
    for (const cell of col) if (isBigPlaque(cell)) n += 1;
  }
  return n;
}

function generateGrid(pick, rng, { bonus = false, superBonus = false } = {}) {
  const matrix = [];
  let big = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const column = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const cell = drawCell(pick, rng, { bonus, superBonus, bigAlready: big > 0 });
      if (isBigPlaque(cell)) big += 1;
      column.push(cell);
    }
    matrix.push(column);
  }
  return matrix;
}

/**
 * Clear the given positions, slide survivors down, refill from the top.
 * Returns { matrix, refills } where refills[col] lists new cells top-down.
 */
function tumble(matrix, removedPositions, pick, rng, { bonus = false, superBonus = false } = {}) {
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const next = [];
  const refills = [];

  let big = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (removed.has(`${col}:${row}`)) continue;
      if (isBigPlaque(matrix[col][row])) big += 1;
    }
  }

  for (let col = 0; col < REEL_COUNT; col += 1) {
    const survivors = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (!removed.has(`${col}:${row}`)) survivors.push(matrix[col][row]);
    }
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      const cell = drawCell(pick, rng, { bonus, superBonus, bigAlready: big > 0 });
      if (isBigPlaque(cell)) big += 1;
      incoming.push(cell);
    }
    refills.push(incoming);
    next.push([...incoming, ...survivors]);
  }
  return { matrix: next, refills };
}

/** Plaques introduced by one refill batch, in board coordinates. */
function plaquesInRefills(refills) {
  const out = [];
  for (let col = 0; col < refills.length; col += 1) {
    for (let row = 0; row < refills[col].length; row += 1) {
      const cell = refills[col][row];
      if (isMultiplier(cell)) {
        out.push({ col, row, value: multiplierValue(cell) });
      }
    }
  }
  return out;
}

/** BONUS coins introduced by one refill batch. */
function scattersInRefills(refills) {
  const out = [];
  for (let col = 0; col < refills.length; col += 1) {
    for (let row = 0; row < refills[col].length; row += 1) {
      if (refills[col][row] === SCATTER) out.push({ col, row });
    }
  }
  return out;
}

/**
 * Resolve one full spin.
 *
 * All amounts are bet multiples:
 * {
 *   initialMatrix, finalMatrix,
 *   steps: [{ wins, stepWin, removedPositions, refills, newMultipliers,
 *             newScatters, matrixAfter }],
 *   baseWin,        // sum of step wins, before the Bonus Box multiplier
 *   multipliers,    // every plaque banked this sequence [{col,row,value}]
 *   multiplierSum,
 *   scatters, scatterCount,
 * }
 */
function resolveSpin({ bonusMode = false, superBonus = false, rng = secureRandom } = {}) {
  const weights = bonusMode ? BONUS_WEIGHTS : BASE_WEIGHTS;
  const pick = buildPicker(weights, rng);
  const drawOpts = { bonus: bonusMode, superBonus: !!superBonus && bonusMode };

  let matrix = generateGrid(pick, rng, drawOpts);
  const initialMatrix = matrix.map((col) => [...col]);

  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(matrix);
    if (wins.length === 0) break;

    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    // A cell can sit on more than one winning route — clear it once.
    const cleared = new Map();
    for (const win of wins) {
      for (const [col, row] of win.positions) cleared.set(`${col}:${row}`, [col, row]);
    }
    const removedPositions = [...cleared.values()];

    const result = tumble(matrix, removedPositions, pick, rng, drawOpts);
    matrix = result.matrix;

    steps.push({
      wins,
      stepWin,
      removedPositions,
      refills: result.refills,
      newMultipliers: plaquesInRefills(result.refills),
      newScatters: scattersInRefills(result.refills),
      matrixAfter: matrix.map((col) => [...col]),
    });
  }

  const multipliers = collectMultipliers(matrix);
  const scatters = collectScatters(matrix);
  return {
    initialMatrix,
    finalMatrix: matrix,
    steps,
    baseWin,
    multipliers,
    multiplierSum: multipliers.reduce((sum, m) => sum + m.value, 0),
    scatters,
    scatterCount: scatters.length,
  };
}

module.exports = {
  resolveSpin,
  generateGrid,
  tumble,
  pickMultiplierValue,
  plaquesInRefills,
  scattersInRefills,
  countBigMultipliers,
  secureRandom,
  secureRandomInt,
  MAX_TUMBLES,
};
