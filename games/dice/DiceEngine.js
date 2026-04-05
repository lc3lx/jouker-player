/**
 * King Arth — 6×5 slot grid, deterministic RNG (serverSeed + clientSeed + nonce).
 * RTP via symbol weights + bonus frequency (volatility); no post-win payout scaling.
 */

const { createSeededRng } = require("./seededRng");

const COLS = 6;
const ROWS = 5;
const SYMBOL_COUNT = 10;
const SCATTER = 9;

/** Extra multiplier on line/scatter wins during free spins */
const FREE_SPIN_PAYOUT_MULT = 2.25;

/** Base weights: five gems, four highs, scatter */
const BASE_WEIGHTS = [22, 22, 22, 22, 22, 12, 10, 8, 6, 2.2];

const VOLATILITY = {
  low: { gem: 1.12, high: 0.92, scatter: 0.65 },
  medium: { gem: 1, high: 1, scatter: 1 },
  high: { gem: 0.9, high: 1.08, scatter: 1.5 },
};

const NEAR_MISS_CHANCE = {
  low: 0.018,
  medium: 0.032,
  high: 0.048,
};

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function normalizeVolatility(v) {
  const s = String(v || "medium").toLowerCase();
  if (s === "low" || s === "high" || s === "medium") return s;
  return "medium";
}

function buildSymbolWeights(volatility) {
  const v = VOLATILITY[normalizeVolatility(volatility)];
  const w = BASE_WEIGHTS.map((x, i) => {
    if (i === SCATTER) return x * v.scatter;
    if (i <= 4) return x * v.gem;
    return x * v.high;
  });
  return w;
}

function pickWeightedSymbol(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return SCATTER;
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

/**
 * Tease: exactly two scatters (no bonus), deterministic extra RNG draws.
 */
function maybeNearMiss(grid, rng, volatility) {
  const sc = countScatters(grid);
  if (sc >= 3) return { applied: false, scatterCount: sc };
  const p = NEAR_MISS_CHANCE[normalizeVolatility(volatility)];
  if (rng() >= p) return { applied: false, scatterCount: sc };

  const positions = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      positions.push([c, r]);
    }
  }
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }

  let need = 2 - sc;
  if (need <= 0) return { applied: false, scatterCount: sc };
  for (let k = 0; k < positions.length && need > 0; k++) {
    const [c, r] = positions[k];
    if (grid[c][r] !== SCATTER) {
      grid[c][r] = SCATTER;
      need--;
    }
  }
  return { applied: true, scatterCount: countScatters(grid) };
}

/** @returns {number[][]} grid[col][row] */
function generateGrid(rng, volatility) {
  const weights = buildSymbolWeights(volatility);
  const grid = [];
  for (let c = 0; c < COLS; c++) {
    grid[c] = [];
    for (let r = 0; r < ROWS; r++) {
      grid[c][r] = pickWeightedSymbol(rng, weights);
    }
  }
  return grid;
}

function lineMultiplier(symbol, runLength) {
  if (symbol === SCATTER) return 0;
  const tier = symbol <= 4 ? "gem" : "high";
  const gem = { 3: 2, 4: 5, 5: 12, 6: 25 };
  const high = { 3: 5, 4: 15, 5: 35, 6: 80 };
  const table = tier === "gem" ? gem : high;
  const len = Math.min(6, Math.max(3, runLength));
  return table[len] ?? table[6];
}

function calculateWins(grid, stake, freeSpinMult = 1) {
  let totalWin = 0;
  const winningCells = new Set();
  const lineWins = [];

  for (let row = 0; row < ROWS; row++) {
    let col = 0;
    while (col < COLS) {
      const sym = grid[col][row];
      if (sym === SCATTER) {
        col += 1;
        continue;
      }
      let run = 1;
      let c = col + 1;
      while (c < COLS && grid[c][row] === sym) {
        run += 1;
        c += 1;
      }
      if (run >= 3) {
        const mult = lineMultiplier(sym, run);
        let win = stake * mult * freeSpinMult;
        win = roundMoney(win);
        totalWin += win;
        for (let k = col; k < col + run; k++) {
          winningCells.add(`${k},${row}`);
        }
        lineWins.push({
          type: "line",
          row,
          startCol: col,
          length: run,
          symbol: sym,
          multiplier: mult,
          freeSpinMult: freeSpinMult,
          win,
        });
      }
      col += run;
    }
  }

  let scatterCount = 0;
  const scatterCells = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (grid[c][r] === SCATTER) {
        scatterCount += 1;
        scatterCells.push({ col: c, row: r });
      }
    }
  }

  if (scatterCount >= 3) {
    const scatterMultTable = { 3: 5, 4: 15, 5: 40, 6: 80 };
    const sm = scatterMultTable[scatterCount] || 120;
    let win = stake * sm * freeSpinMult;
    win = roundMoney(win);
    totalWin += win;
    for (const cell of scatterCells) {
      winningCells.add(`${cell.col},${cell.row}`);
    }
    lineWins.push({
      type: "scatter",
      count: scatterCount,
      multiplier: sm,
      freeSpinMult: freeSpinMult,
      win,
      scatterCells,
    });
  }

  return {
    totalWin: roundMoney(totalWin),
    winningCells: [...winningCells].map((s) => {
      const [a, b] = s.split(",").map(Number);
      return { col: a, row: b };
    }),
    lineWins,
    scatterCount,
  };
}

function classifyWinType(totalWin, stake) {
  if (totalWin <= 0 || stake <= 0) return "normal";
  const ratio = totalWin / stake;
  if (ratio >= 15) return "mega";
  if (ratio >= 5) return "big";
  return "normal";
}

function buildCascadeSteps(lineWins) {
  const steps = [];
  for (const w of lineWins) {
    if (w.type === "line") {
      const cells = [];
      for (let k = 0; k < w.length; k++) {
        cells.push({ col: w.startCol + k, row: w.row });
      }
      steps.push({
        phase: "line",
        row: w.row,
        multiplier: w.multiplier,
        freeSpinMult: w.freeSpinMult,
        win: w.win,
        cells,
      });
    } else if (w.type === "scatter") {
      steps.push({
        phase: "scatter",
        count: w.count,
        multiplier: w.multiplier,
        freeSpinMult: w.freeSpinMult,
        win: w.win,
        cells: w.scatterCells || [],
      });
    }
  }
  return steps;
}

/**
 * @param {number} baseBet
 * @param {object} options
 * @param {string} options.serverSeed
 * @param {string} options.clientSeed
 * @param {string} options.nonce
 * @param {boolean} [options.doubleChance]
 * @param {boolean} [options.isFreeSpin]
 * @param {string} [options.volatility] low|medium|high
 */
function spin(baseBet, options = {}) {
  const doubleChance = !!options.doubleChance;
  const stake = roundMoney(baseBet * (doubleChance ? 1.25 : 1));
  const isFreeSpin = !!options.isFreeSpin;
  const freeSpinMult = isFreeSpin ? FREE_SPIN_PAYOUT_MULT : 1;
  const volatility = normalizeVolatility(options.volatility);

  const rng = createSeededRng(
    options.serverSeed,
    options.clientSeed,
    options.nonce
  );
  let grid = generateGrid(rng, volatility);
  const nearMiss = maybeNearMiss(grid, rng, volatility);

  let { totalWin, winningCells, lineWins, scatterCount } = calculateWins(
    grid,
    stake,
    freeSpinMult
  );

  const winType = classifyWinType(totalWin, stake);
  const cascadeSteps = buildCascadeSteps(lineWins);
  const almostBonus = scatterCount === 2;

  return {
    grid,
    stake,
    baseBet: roundMoney(baseBet),
    doubleChance,
    isFreeSpin,
    freeSpinPayoutMult: freeSpinMult,
    volatility,
    nearMiss: nearMiss.applied,
    almostBonus,
    totalWin,
    winningCells,
    lineWins,
    scatterCount,
    winType,
    cascadeSteps,
    multipliers: {
      freeSpin: freeSpinMult,
    },
  };
}

module.exports = {
  COLS,
  ROWS,
  SYMBOL_COUNT,
  SCATTER,
  FREE_SPIN_PAYOUT_MULT,
  normalizeVolatility,
  generateGrid,
  calculateWins,
  spin,
  classifyWinType,
};
