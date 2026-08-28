/**
 * King Earth slot engine.
 *
 * The presentation keeps its legacy `dice_*` socket contract, while the game
 * maths follows Poseidon: 6x5 scatter pays, 7+ symbols win, winning symbols
 * tumble, and multiplier plaques remain in place until the sequence ends.
 */
const { createSeededRng } = require("./seededRng");

const COLS = 6;
const ROWS = 5;
const REGULAR_SYMBOLS = 8;
const MULTIPLIER = 8;
// Exact Poseidon plaque ladder and weighted face distribution.
const MULTIPLIER_VALUES = [2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** Scatter jackpot — 3+ on finalGrid opens the match-3 scratch round. */
const JACKPOT = REGULAR_SYMBOLS + MULTIPLIER_VALUES.length; // 17
const JACKPOT_WEIGHT = 0.25;
const JACKPOT_MIN_SYMBOLS = 3;
const SYMBOL_COUNT = JACKPOT + 1;
const FREE_SPINS_AWARD = 5;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;
const RETRIGGER_MIN_SCATTER = 3;
const BUY_COST_MULT = 30;
const SUPER_BUY_COST_MULT = 90;
const SUPER_MULTIPLIER_MIN = 20;
const MAX_WIN_MULTIPLIER = 5000;
const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MIN_MATCH = 7;

// Kept as aliases because the socket/client response historically calls the
// plaque counter `scatterCount`.
const SCATTER = MULTIPLIER;
const GEM_SYMBOLS = [0, 1, 2, 3];

// A, E, N, S, book, ring, class, crown.  The values and match bands are the
// Poseidon paytable, applied to the new King Earth art.
const PAYTABLE = {
  0: [1, 1.15, 1.5], 1: [1, 1.15, 1.5], 2: [1, 1.15, 1.5], 3: [1, 1.15, 1.5],
  4: [1.15, 1.5, 2.2], 5: [1.3, 1.85, 2.8], 6: [1.5, 2.3, 3.5], 7: [2, 3.5, 5],
};
// Scaled from Poseidon's non-plaque mass.  King Earth has four supplied
// premium symbols rather than Poseidon's five, so scaling preserves the exact
// Poseidon probability of a plaque on every base/bonus draw.
const BASE_WEIGHTS = [
  10.73943662, 10.73943662, 10.73943662, 10.73943662,
  9.66549296, 9.66549296, 8.05457746, 5.90669014,
];
const FREESPIN_WEIGHTS = [...BASE_WEIGHTS];
const BASE_MULTIPLIER_WEIGHTS = [82, 11, 4.2, 1.6, .7, .3, .12, .05, .02];
const BONUS_MULTIPLIER_WEIGHTS = [62, 16, 10, 5.5, 3, 1.8, .9, .45, .2];
const SUPPRESSED_MULTIPLIER_WEIGHTS = [88, 9, 2.2, .5, .15, .05, .015, .005, .002];
const MULTIPLIER_GATES = [.48, .35, .33, .32, .35, .4, .4, .35, .4];
const BIG_MULTIPLIER_THRESHOLD = 20;
const APPLIED_MULTIPLIER_CAP_BASE = Number.POSITIVE_INFINITY;
const APPLIED_MULTIPLIER_CAP_BONUS = Number.POSITIVE_INFINITY;
const MAX_TUMBLES = 40;

function roundMoney(n) { return Math.round(Number(n) * 100) / 100; }
function normalizeVolatility(v) { return ["low", "medium", "high"].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : "medium"; }
function cloneGrid(grid) { return grid.map((col) => [...col]); }
function isMultiplier(symbol) {
  return symbol >= MULTIPLIER && symbol < JACKPOT;
}
function multiplierValue(symbol) { return isMultiplier(symbol) ? MULTIPLIER_VALUES[symbol - MULTIPLIER] : 0; }
function weightedIndex(rng, weights) { let r = rng() * weights.reduce((a, b) => a + b, 0); for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r < 0) return i; } return 0; }
function pickMultiplierValue(rng, volatility, { bonus = false, bigAlready = false, superBonus = false } = {}) {
  const weights = bigAlready ? SUPPRESSED_MULTIPLIER_WEIGHTS : (bonus || superBonus) ? BONUS_MULTIPLIER_WEIGHTS : BASE_MULTIPLIER_WEIGHTS;
  if (superBonus) {
    const start = MULTIPLIER_VALUES.findIndex((v) => v >= SUPER_MULTIPLIER_MIN);
    return MULTIPLIER_VALUES.slice(start)[weightedIndex(rng, weights.slice(start))];
  }
  return MULTIPLIER_VALUES[weightedIndex(rng, weights)];
}
function isJackpot(symbol) {
  return symbol === JACKPOT;
}

function pickSymbol(rng, isFreeSpin, bigAlready, superBonus = false) {
  const plaqueWeight = isFreeSpin ? 0.55 : 0.22;
  const regular = isFreeSpin ? FREESPIN_WEIGHTS : BASE_WEIGHTS;
  const choice = weightedIndex(rng, [...regular, plaqueWeight, JACKPOT_WEIGHT]);
  if (choice < REGULAR_SYMBOLS) return choice;
  if (choice === REGULAR_SYMBOLS) {
    const value = pickMultiplierValue(rng, "medium", { bonus: isFreeSpin, bigAlready, superBonus });
    return MULTIPLIER + MULTIPLIER_VALUES.indexOf(value);
  }
  return JACKPOT;
}

function countJackpotSymbols(grid) {
  let count = 0;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (isJackpot(grid[c][r])) count++;
    }
  }
  return count;
}
function generateGrid(rng, volatility, doubleChance = false, isFreeSpin = false, superBonus = false) {
  const grid = []; let hasBig = false;
  for (let c = 0; c < COLS; c++) { grid[c] = []; for (let r = 0; r < ROWS; r++) { const s = pickSymbol(rng, isFreeSpin, hasBig, superBonus); if (multiplierValue(s) >= BIG_MULTIPLIER_THRESHOLD) hasBig = true; grid[c][r] = s; } }
  return grid;
}
function payBand(count) { return count >= 12 ? 2 : count >= 10 ? 1 : count >= MIN_MATCH ? 0 : -1; }
function symbolMultiplier(symbol, count) { const band = payBand(count); return band < 0 ? 0 : (PAYTABLE[symbol] || [])[band] || 0; }
function findPayAnywhereWins(grid, stake) {
  const wins = [], winningCells = new Set();
  for (let symbol = 0; symbol < REGULAR_SYMBOLS; symbol++) {
    const cells = []; for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === symbol) cells.push({ col: c, row: r });
    const multiplier = symbolMultiplier(symbol, cells.length); if (!multiplier) continue;
    cells.forEach((cell) => winningCells.add(`${cell.col},${cell.row}`));
    wins.push({ type: "pay_anywhere", symbol, count: cells.length, multiplier, win: roundMoney(stake * multiplier), cells });
  }
  return { wins, winningCells };
}
function multiplierCells(grid) { const cells = []; for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) { const value = multiplierValue(grid[c][r]); if (value) cells.push({ col: c, row: r, value }); } return cells; }
function collapseGrid(grid, removed, rng, volatility, doubleChance, isFreeSpin, superBonus = false) {
  const next = []; let hasBig = multiplierCells(grid).some((m) => m.value >= BIG_MULTIPLIER_THRESHOLD);
  for (let c = 0; c < COLS; c++) { const survivors = []; for (let r = 0; r < ROWS; r++) if (!removed.has(`${c},${r}`)) survivors.push(grid[c][r]); const incoming = []; while (incoming.length + survivors.length < ROWS) { const s = pickSymbol(rng, isFreeSpin, hasBig, superBonus); if (multiplierValue(s) >= BIG_MULTIPLIER_THRESHOLD) hasBig = true; incoming.push(s); } next[c] = [...incoming, ...survivors]; }
  return next;
}
function appliedMultiplierFor(sum, isBonus) { return sum > 0 ? sum : 1; }
function classifyWinType(total, stake) { const r = total / Math.max(stake, 1); return r >= 50 ? "mega" : r >= 12 ? "big" : "normal"; }
function runTumbles(initialGrid, rng, options) {
  let grid = cloneGrid(initialGrid), baseWin = 0; const lineWins = [], winningCells = new Set(), cascadeSteps = [];
  for (let index = 0; index < MAX_TUMBLES; index++) {
    const beforeGrid = cloneGrid(grid), { wins, winningCells: stepKeys } = findPayAnywhereWins(grid, options.stake);
    if (!wins.length) break;
    const stepWin = roundMoney(wins.reduce((sum, w) => sum + w.win, 0)); baseWin = roundMoney(baseWin + stepWin);
    const afterGrid = collapseGrid(grid, stepKeys, rng, options.volatility, options.doubleChance, options.isFreeSpin, options.superBonus);
    stepKeys.forEach((key) => winningCells.add(key)); lineWins.push(...wins);
    cascadeSteps.push({ phase: "tumble", index, grid: beforeGrid, afterGrid: cloneGrid(afterGrid), win: stepWin, wins, cells: [...stepKeys].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), multiplierHits: multiplierCells(afterGrid), multiplierTotal: multiplierCells(afterGrid).reduce((sum, m) => sum + m.value, 0) });
    grid = afterGrid;
  }
  const plaques = multiplierCells(grid), collected = plaques.reduce((sum, p) => sum + p.value, 0);
  // Same as Poseidon: plaques only multiply a tumble win — never a zero-win spin.
  // Applied = full face-value plaque sum (no soft-cap); MAX_WIN still hard-caps payout.
  const applied = baseWin > 0 && collected > 0
    ? appliedMultiplierFor(collected, options.isFreeSpin)
    : 1;
  return { finalGrid: grid, baseWin, collectedMultiplier: collected, appliedMultiplier: applied, nextFreeSpinMultiplier: applied, multipliedWin: roundMoney(baseWin * applied), lineWins, winningCells, cascadeSteps };
}
function calculateWins(grid, stake, freeSpinMultiplier = 0) { const { wins, winningCells } = findPayAnywhereWins(grid, stake); const totalWin = wins.reduce((sum, w) => sum + w.win, 0); return { totalWin: roundMoney(totalWin), winningCells: [...winningCells].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), lineWins: wins, scatterCount: multiplierCells(grid).length }; }
function spin(baseBet, options = {}) {
  const rng = createSeededRng(options.serverSeed, options.clientSeed, options.nonce), isFreeSpin = !!options.isFreeSpin, superBonus = !!(isFreeSpin && options.superBonus), stake = roundMoney(baseBet);
  const initialGrid = generateGrid(rng, options.volatility, false, isFreeSpin, superBonus);
  const tumble = runTumbles(initialGrid, rng, { stake, volatility: normalizeVolatility(options.volatility), doubleChance: false, isFreeSpin, superBonus });
  const scatterCount = multiplierCells(tumble.finalGrid).length, winCap = roundMoney(MAX_WIN_MULTIPLIER * stake);
  const totalWin = Math.min(tumble.multipliedWin, winCap);
  const jackpotSymbolCount = countJackpotSymbols(tumble.finalGrid);
  return { grid: initialGrid, initialGrid, finalGrid: tumble.finalGrid, stake, baseBet: stake, doubleChance: false, isFreeSpin, freeSpinPayoutMult: 1, volatility: normalizeVolatility(options.volatility), nearMiss: false, almostBonus: !isFreeSpin && scatterCount === 3, capped: tumble.multipliedWin > winCap, maxWin: winCap, totalWin, baseWin: tumble.baseWin, winningCells: [...tumble.winningCells].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), lineWins: tumble.lineWins, scatterCount, jackpotSymbolCount, jackpotTriggered: jackpotSymbolCount >= JACKPOT_MIN_SYMBOLS, winType: classifyWinType(totalWin, stake), cascadeSteps: tumble.cascadeSteps, multipliers: { collected: tumble.collectedMultiplier, applied: tumble.appliedMultiplier, freeSpinTotal: tumble.nextFreeSpinMultiplier }, freeSpinsAwarded: !isFreeSpin && scatterCount >= 4 ? FREE_SPINS_AWARD : 0 };
}
module.exports = { COLS, ROWS, REGULAR_SYMBOLS, SYMBOL_COUNT, SCATTER, MULTIPLIER, JACKPOT, JACKPOT_WEIGHT, JACKPOT_MIN_SYMBOLS, GEM_SYMBOLS, FREE_SPINS_AWARD, FREE_SPINS_BOUGHT, RETRIGGER_AWARD, RETRIGGER_MIN_SCATTER, BUY_COST_MULT, SUPER_BUY_COST_MULT, SUPER_MULTIPLIER_MIN, MAX_WIN_MULTIPLIER, BET_MIN, BET_MAX, PAYTABLE, MULTIPLIER_VALUES, BASE_WEIGHTS, FREESPIN_WEIGHTS, MULTIPLIER_GATES, BASE_MULTIPLIER_WEIGHTS, BONUS_MULTIPLIER_WEIGHTS, SUPPRESSED_MULTIPLIER_WEIGHTS, BIG_MULTIPLIER_THRESHOLD, APPLIED_MULTIPLIER_CAP_BASE, APPLIED_MULTIPLIER_CAP_BONUS, appliedMultiplierFor, normalizeVolatility, pickMultiplierValue, symbolMultiplier, isJackpot, countJackpotSymbols, generateGrid, calculateWins, spin, classifyWinType };
