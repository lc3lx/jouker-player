/**
 * King Earth (Zeus) — 6×5 pay-anywhere tumble slot, deterministic RNG
 * (serverSeed + clientSeed + nonce).
 *
 * Matches the reference "Gates of Olympus"-style rules:
 * - 8+ matching regular symbols anywhere pay (per-symbol paytable, bet multiples).
 * - Winning symbols disappear and new symbols fall from the top (tumble).
 * - Multiplier orbs land during winning tumbles: base game sums the orbs of the
 *   whole sequence; free spins accumulate a persistent total for the round.
 * - 4+ scatters award 15 free spins; 3+ scatters during free spins add 5 more.
 * - Total round win is capped at 4000× the stake.
 *
 * Data-driven config lives at the top of this file (paytable / scatter pays /
 * symbol weights / multiplier distribution). RTP is tuned to ~96.5% at the
 * default "medium" volatility via the seeded simulation in test/kingEarth.rtp.js.
 *
 * NOTE: the `dice` folder name and the `spin`/grid integer-index contract are
 * legacy — this is the King Earth slot engine consumed by the `dice_spin`
 * socket handler and the provable-fairness verify endpoint.
 */

const { createSeededRng } = require("./seededRng");

const COLS = 6;
const ROWS = 5;
const REGULAR_SYMBOLS = 9;
const SCATTER = 9;
const MULTIPLIER = 10;
const SYMBOL_COUNT = 11;

// Free spins / feature economy
const FREE_SPINS_AWARD = 15; // initial trigger (4+ scatters)
const RETRIGGER_AWARD = 5; // extra spins when 3+ scatters land during free spins
const RETRIGGER_MIN_SCATTER = 3;
const BUY_COST_MULT = 100; // buy free spins costs 100× the total bet
const MAX_WIN_MULTIPLIER = 4000; // round win cap, in stake multiples
const MAX_TUMBLES = 12;

// Bet limits (total bet, in currency units)
const BET_MIN = 0.2;
const BET_MAX = 300;

// Symbol indices (frontend/backend contract — do not reorder):
// 0 ruby, 1 sunstone, 2 amethyst, 3 emerald, 4 sapphire (gems)
// 5 crown, 6 hourglass, 7 ring, 8 chalice (premium)
// 9 scatter (Zeus), 10 multiplier orb
const GEM_SYMBOLS = [0, 1, 2, 3, 4];

/**
 * Per-symbol paytable, as multiples of the TOTAL bet.
 * Bands: [8–9 of a kind, 10–11 of a kind, 12+ of a kind].
 * Values transcribed from the reference screenshots (shown $ at a $0.25 bet,
 * divided by 0.25 → bet multiplier).
 */
const PAYTABLE = {
  5: [8, 20, 40], // CROWN
  6: [2, 8, 20], // HOURGLASS
  7: [1.6, 4, 12], // RING
  8: [1.2, 1.6, 9.6], // CHALICE
  0: [0.8, 1.2, 8], // RUBY (red)
  2: [0.64, 0.96, 6.4], // AMETHYST (purple)
  1: [0.4, 0.8, 4], // SUNSTONE (yellow)
  3: [0.32, 0.72, 3.2], // EMERALD (green)
  4: [0.2, 0.6, 1.6], // SAPPHIRE (blue)
};

/** Scatter (Zeus) pay-anywhere, as multiples of the total bet. 6 means 6+. */
const SCATTER_PAYS = { 4: 2.4, 5: 4, 6: 80 };

const MULTIPLIER_VALUES = [
  2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100, 250, 500,
];

/**
 * Per-symbol draw weights (independent weighted pick per cell).
 * Order matches the symbol indices above (11 entries).
 * Lower-paying symbols are common, premiums rare. Tuned to ~96.5% RTP
 * at the default "medium" volatility (see test/kingEarth.rtp.js).
 */
const BASE_WEIGHTS = [
  15.5, // 0 ruby
  22, // 1 sunstone
  17, // 2 amethyst
  24, // 3 emerald
  26, // 4 sapphire
  6.2, // 5 crown
  8.5, // 6 hourglass
  10.5, // 7 ring
  13, // 8 chalice
  3.5, // 9 scatter
  0.8, // 10 multiplier
];

/**
 * Free-spins "special reels": richer scatter + multiplier presence so the
 * bonus carries most of the volatility, mirroring the reference game.
 */
const FREESPIN_WEIGHTS = [
  15.5, // 0 ruby
  22, // 1 sunstone
  17, // 2 amethyst
  24, // 3 emerald
  26, // 4 sapphire
  6.2, // 5 crown
  8.5, // 6 hourglass
  10.5, // 7 ring
  13, // 8 chalice
  4.0, // 9 scatter (more retriggers)
  4.45, // 10 multiplier (orbs rain in the bonus)
];

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

/** Multiplier-orb value distribution (parallel to MULTIPLIER_VALUES). */
const MULTIPLIER_WEIGHTS = {
  high: [28, 24, 18, 14, 10, 8, 7, 5, 4, 3, 2.2, 1.15, 0.45, 0.16, 0.06],
  low: [40, 26, 18, 11, 8, 5, 3.2, 2.2, 1.2, 0.8, 0.45, 0.16, 0.05, 0.01, 0.004],
  medium: [34, 25, 18, 12, 9, 6, 4.5, 3, 1.8, 1.2, 0.7, 0.28, 0.09, 0.025, 0.008],
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

function buildSymbolWeights(volatility, doubleChance = false, isFreeSpin = false) {
  const v = VOLATILITY[normalizeVolatility(volatility)];
  const base = isFreeSpin ? FREESPIN_WEIGHTS : BASE_WEIGHTS;
  return base.map((x, i) => {
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
  const weights =
    MULTIPLIER_WEIGHTS[normalizeVolatility(volatility)] || MULTIPLIER_WEIGHTS.medium;
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
function generateGrid(rng, volatility, doubleChance = false, isFreeSpin = false) {
  const weights = buildSymbolWeights(volatility, doubleChance, isFreeSpin);
  const grid = [];
  for (let c = 0; c < COLS; c++) {
    grid[c] = [];
    for (let r = 0; r < ROWS; r++) {
      grid[c][r] = pickWeightedSymbol(rng, weights);
    }
  }
  return grid;
}

function payBand(count) {
  if (count >= 12) return 2;
  if (count >= 10) return 1;
  if (count >= 8) return 0;
  return -1;
}

function symbolMultiplier(symbol, count) {
  const band = payBand(count);
  if (band < 0) return 0;
  const bands = PAYTABLE[symbol];
  if (!bands) return 0;
  return bands[band] || 0;
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
  const key = count >= 6 ? 6 : count;
  const multiplier = SCATTER_PAYS[key] || 0;
  if (multiplier <= 0) return null;
  return {
    type: "scatter",
    count,
    multiplier,
    win: roundMoney(stake * multiplier),
    cells: scatterCells,
  };
}

function collapseGrid(grid, removedKeys, rng, volatility, doubleChance, isFreeSpin) {
  const weights = buildSymbolWeights(volatility, doubleChance, isFreeSpin);
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

    const afterGrid = collapseGrid(
      grid,
      removedKeys,
      rng,
      volatility,
      doubleChance,
      isFreeSpin
    );
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

  // Base game: sum all orbs collected in the sequence and multiply the sequence
  // win. Free spins: carry a persistent accumulator across the whole round.
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
  const initialGrid = generateGrid(rng, volatility, doubleChance, isFreeSpin);
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

  // Cap the per-spin win at 4000× the stake.
  const winCap = roundMoney(MAX_WIN_MULTIPLIER * stake);
  let capped = false;
  if (totalWin > winCap) {
    totalWin = winCap;
    capped = true;
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
    capped,
    maxWin: winCap,
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
  GEM_SYMBOLS,
  FREE_SPINS_AWARD,
  RETRIGGER_AWARD,
  RETRIGGER_MIN_SCATTER,
  BUY_COST_MULT,
  MAX_WIN_MULTIPLIER,
  BET_MIN,
  BET_MAX,
  PAYTABLE,
  SCATTER_PAYS,
  MULTIPLIER_VALUES,
  BASE_WEIGHTS,
  FREESPIN_WEIGHTS,
  normalizeVolatility,
  buildSymbolWeights,
  pickMultiplierValue,
  symbolMultiplier,
  generateGrid,
  calculateWins,
  spin,
  classifyWinType,
};
