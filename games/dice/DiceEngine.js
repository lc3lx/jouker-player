/**
 * King Arth — 6×5 scatter-pay slot, deterministic RNG
 * (serverSeed + clientSeed + nonce).
 *
 * Inspired by "pay anywhere" tumble slots:
 * - 8+ matching regular symbols anywhere pay.
 * - Winning symbols disappear and new symbols fall from the top.
 * - Multiplier orbs can land during winning tumbles.
 * - 4+ scatters award 15 free spins.
 */

const { createSeededRng } = require("./seededRng");

const COLS = 6;
const ROWS = 5;
const REGULAR_SYMBOLS = 9;
const SCATTER = 9;
const MULTIPLIER = 10;
const SYMBOL_COUNT = 11;
const FREE_SPINS_AWARD = 15;
const MAX_TUMBLES = 12;

const MULTIPLIER_VALUES = [
  2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100, 250, 500,
];

/** Five gems, four premium symbols, scatter, multiplier orb. */
const BASE_WEIGHTS = [22, 22, 22, 22, 22, 11, 9, 8, 7, 1.8, 1.45];

const VOLATILITY = {
  low: { gem: 1.12, high: 0.9, scatter: 0.7, multiplier: 0.82 },
  medium: { gem: 1, high: 1, scatter: 1, multiplier: 1 },
  high: { gem: 0.9, high: 1.12, scatter: 1.35, multiplier: 1.18 },
};

const NEAR_MISS_CHANCE = {
  low: 0.018,
  medium: 0.032,
  high: 0.048,
};

const PAY_TABLE = {
  gem: { 8: 0.25, 10: 0.75, 12: 2 },
  high: { 8: 0.5, 10: 1.5, 12: 5 },
};

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function cloneGrid(grid) {
  return grid.map((col) => [...col]);
}

function normalizeVolatility(v) {
  const s = String(v || "medium").toLowerCase();
  if (s === "low" || s === "high" || s === "medium") return s;
  return "medium";
}

function buildSymbolWeights(volatility, doubleChance = false) {
  const v = VOLATILITY[normalizeVolatility(volatility)];
  return BASE_WEIGHTS.map((x, i) => {
    if (i === SCATTER) return x * v.scatter * (doubleChance ? 1.65 : 1);
    if (i === MULTIPLIER) return x * v.multiplier;
    if (i <= 4) return x * v.gem;
    return x * v.high;
  });
}

function pickWeightedSymbol(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return 0;
}

function pickMultiplierValue(rng, volatility) {
  const v = normalizeVolatility(volatility);
  const weights =
    v === "high"
      ? [28, 24, 18, 14, 10, 8, 7, 5, 4, 3, 2.2, 1.15, 0.45, 0.16, 0.06]
      : v === "low"
        ? [40, 26, 18, 11, 8, 5, 3.2, 2.2, 1.2, 0.8, 0.45, 0.16, 0.05, 0.01, 0.004]
        : [34, 25, 18, 12, 9, 6, 4.5, 3, 1.8, 1.2, 0.7, 0.28, 0.09, 0.025, 0.008];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < MULTIPLIER_VALUES.length; i++) {
    r -= weights[i];
    if (r <= 0) return MULTIPLIER_VALUES[i];
  }
  return 2;
}

function countScatters(grid) {
  let n = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r] === SCATTER) n++;
    }
  }
  return n;
}

function maybeNearMiss(grid, rng, volatility) {
  const sc = countScatters(grid);
  if (sc >= 4) return { applied: false, scatterCount: sc };
  const p = NEAR_MISS_CHANCE[normalizeVolatility(volatility)];
  if (rng() >= p) return { applied: false, scatterCount: sc };

  const positions = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r] !== SCATTER) positions.push([c, r]);
    }
  }
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  let need = 3 - sc;
  for (let k = 0; k < positions.length && need > 0; k++) {
    const [c, r] = positions[k];
    grid[c][r] = SCATTER;
    need--;
  }
  return { applied: true, scatterCount: countScatters(grid) };
}

/** @returns {number[][]} grid[col][row] */
function generateGrid(rng, volatility, doubleChance = false) {
  const weights = buildSymbolWeights(volatility, doubleChance);
  const grid = [];
  for (let c = 0; c < COLS; c++) {
    grid[c] = [];
    for (let r = 0; r < ROWS; r++) {
      grid[c][r] = pickWeightedSymbol(rng, weights);
    }
  }
  return grid;
}

function payBucket(count) {
  if (count >= 12) return 12;
  if (count >= 10) return 10;
  if (count >= 8) return 8;
  return 0;
}

function symbolMultiplier(symbol, count) {
  const bucket = payBucket(count);
  if (!bucket) return 0;
  const tier = symbol <= 4 ? "gem" : "high";
  return PAY_TABLE[tier][bucket] || 0;
}

function findScatterCells(grid) {
  const cells = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r] === SCATTER) cells.push({ col: c, row: r });
    }
  }
  return cells;
}

function findMultiplierCells(grid, rng, volatility) {
  const cells = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r] === MULTIPLIER) {
        cells.push({ col: c, row: r, value: pickMultiplierValue(rng, volatility) });
      }
    }
  }
  return cells;
}

function findPayAnywhereWins(grid, stake) {
  const wins = [];
  const winningCells = new Set();

  for (let symbol = 0; symbol < REGULAR_SYMBOLS; symbol++) {
    const cells = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (grid[c][r] === symbol) cells.push({ col: c, row: r });
      }
    }
    const count = cells.length;
    const multiplier = symbolMultiplier(symbol, count);
    if (multiplier <= 0) continue;
    for (const cell of cells) winningCells.add(`${cell.col},${cell.row}`);
    wins.push({
      type: "pay_anywhere",
      symbol,
      count,
      multiplier,
      win: roundMoney(stake * multiplier),
      cells,
    });
  }

  return { wins, winningCells };
}

function scatterWin(scatterCells, stake) {
  const count = scatterCells.length;
  if (count < 4) return null;
  const multiplier = count >= 6 ? 100 : count === 5 ? 5 : 3;
  return {
    type: "scatter",
    count,
    multiplier,
    win: roundMoney(stake * multiplier),
    cells: scatterCells,
  };
}

function collapseGrid(grid, removedKeys, rng, volatility, doubleChance) {
  const weights = buildSymbolWeights(volatility, doubleChance);
  const next = [];

  for (let c = 0; c < COLS; c++) {
    const survivorsBottomFirst = [];
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!removedKeys.has(`${c},${r}`)) survivorsBottomFirst.push(grid[c][r]);
    }

    const col = [];
    const missing = ROWS - survivorsBottomFirst.length;
    for (let i = 0; i < missing; i++) {
      col.push(pickWeightedSymbol(rng, weights));
    }
    for (let i = survivorsBottomFirst.length - 1; i >= 0; i--) {
      col.push(survivorsBottomFirst[i]);
    }
    next[c] = col;
  }

  return next;
}

function classifyWinType(totalWin, stake) {
  if (totalWin <= 0 || stake <= 0) return "normal";
  const ratio = totalWin / stake;
  if (ratio >= 50) return "mega";
  if (ratio >= 12) return "big";
  return "normal";
}

function runTumbles(initialGrid, rng, options) {
  const {
    stake,
    volatility,
    doubleChance,
    isFreeSpin,
    freeSpinMultiplier = 0,
  } = options;
  let grid = cloneGrid(initialGrid);
  let baseWin = 0;
  let collectedMultiplier = 0;
  const lineWins = [];
  const winningCells = new Set();
  const cascadeSteps = [];

  for (let tumble = 0; tumble < MAX_TUMBLES; tumble++) {
    const beforeGrid = cloneGrid(grid);
    const { wins, winningCells: stepWinningKeys } = findPayAnywhereWins(grid, stake);
    if (wins.length === 0) break;

    const multiplierHits = findMultiplierCells(grid, rng, volatility);
    const multiplierTotal = multiplierHits.reduce((sum, hit) => sum + hit.value, 0);
    const stepWin = roundMoney(wins.reduce((sum, win) => sum + win.win, 0));
    baseWin = roundMoney(baseWin + stepWin);
    collectedMultiplier += multiplierTotal;

    const removedKeys = new Set(stepWinningKeys);
    for (const hit of multiplierHits) removedKeys.add(`${hit.col},${hit.row}`);
    for (const key of stepWinningKeys) winningCells.add(key);
    lineWins.push(...wins);

    const afterGrid = collapseGrid(grid, removedKeys, rng, volatility, doubleChance);
    cascadeSteps.push({
      phase: "tumble",
      index: tumble,
      grid: beforeGrid,
      afterGrid: cloneGrid(afterGrid),
      win: stepWin,
      wins,
      cells: [...stepWinningKeys].map((s) => {
        const [col, row] = s.split(",").map(Number);
        return { col, row };
      }),
      multiplierHits,
      multiplierTotal,
    });

    grid = afterGrid;
  }

  const nextFreeSpinMultiplier = isFreeSpin
    ? freeSpinMultiplier + collectedMultiplier
    : 0;
  const appliedMultiplier = isFreeSpin
    ? nextFreeSpinMultiplier
    : collectedMultiplier;
  const multipliedWin =
    baseWin > 0 && appliedMultiplier > 0
      ? roundMoney(baseWin * appliedMultiplier)
      : baseWin;

  return {
    finalGrid: grid,
    baseWin,
    collectedMultiplier,
    appliedMultiplier,
    nextFreeSpinMultiplier,
    multipliedWin,
    lineWins,
    winningCells,
    cascadeSteps,
  };
}

function calculateWins(grid, stake, freeSpinMultiplier = 0) {
  const scatterCells = findScatterCells(grid);
  const sWin = scatterWin(scatterCells, stake);
  const { wins, winningCells } = findPayAnywhereWins(grid, stake);
  let totalWin = wins.reduce((sum, win) => sum + win.win, 0);
  if (sWin) totalWin += sWin.win;
  if (freeSpinMultiplier > 0 && totalWin > 0) {
    totalWin *= freeSpinMultiplier;
  }
  if (sWin) {
    for (const cell of sWin.cells) winningCells.add(`${cell.col},${cell.row}`);
    wins.push(sWin);
  }
  return {
    totalWin: roundMoney(totalWin),
    winningCells: [...winningCells].map((s) => {
      const [col, row] = s.split(",").map(Number);
      return { col, row };
    }),
    lineWins: wins,
    scatterCount: scatterCells.length,
  };
}

/**
 * @param {number} baseBet
 * @param {object} options
 * @param {string} options.serverSeed
 * @param {string} options.clientSeed
 * @param {string} options.nonce
 * @param {boolean} [options.doubleChance]
 * @param {boolean} [options.isFreeSpin]
 * @param {number} [options.freeSpinMultiplier]
 * @param {string} [options.volatility] low|medium|high
 */
function spin(baseBet, options = {}) {
  const doubleChance = !!options.doubleChance;
  const stake = roundMoney(baseBet * (doubleChance ? 1.25 : 1));
  const isFreeSpin = !!options.isFreeSpin;
  const volatility = normalizeVolatility(options.volatility);
  const freeSpinMultiplier = Number(options.freeSpinMultiplier || 0);

  const rng = createSeededRng(
    options.serverSeed,
    options.clientSeed,
    options.nonce
  );
  const initialGrid = generateGrid(rng, volatility, doubleChance);
  const nearMiss = maybeNearMiss(initialGrid, rng, volatility);
  const scatterCells = findScatterCells(initialGrid);
  const sWin = scatterWin(scatterCells, stake);

  const tumble = runTumbles(initialGrid, rng, {
    stake,
    volatility,
    doubleChance,
    isFreeSpin,
    freeSpinMultiplier,
  });

  let totalWin = tumble.multipliedWin;
  const lineWins = [...tumble.lineWins];
  const winningCells = new Set(tumble.winningCells);

  if (sWin) {
    totalWin = roundMoney(totalWin + sWin.win);
    lineWins.push(sWin);
    for (const cell of scatterCells) winningCells.add(`${cell.col},${cell.row}`);
  }

  const winType = classifyWinType(totalWin, stake);
  const scatterCount = scatterCells.length;
  const freeSpinsAwarded = scatterCount >= 4 ? FREE_SPINS_AWARD : 0;

  return {
    grid: initialGrid,
    initialGrid,
    finalGrid: tumble.finalGrid,
    stake,
    baseBet: roundMoney(baseBet),
    doubleChance,
    isFreeSpin,
    freeSpinPayoutMult: 1,
    volatility,
    nearMiss: nearMiss.applied,
    almostBonus: scatterCount === 3,
    totalWin: roundMoney(totalWin),
    baseWin: tumble.baseWin,
    winningCells: [...winningCells].map((s) => {
      const [col, row] = s.split(",").map(Number);
      return { col, row };
    }),
    lineWins,
    scatterCount,
    winType,
    cascadeSteps: tumble.cascadeSteps,
    multipliers: {
      collected: tumble.collectedMultiplier,
      applied: tumble.appliedMultiplier,
      freeSpinTotal: tumble.nextFreeSpinMultiplier,
    },
    freeSpinsAwarded,
  };
}

module.exports = {
  COLS,
  ROWS,
  REGULAR_SYMBOLS,
  SYMBOL_COUNT,
  SCATTER,
  MULTIPLIER,
  FREE_SPINS_AWARD,
  normalizeVolatility,
  generateGrid,
  calculateWins,
  spin,
  classifyWinType,
};
