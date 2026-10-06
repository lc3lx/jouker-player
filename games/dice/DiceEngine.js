const calibration = require("./zeusEconomyV4.json");
const ECONOMY_VERSION = 4;
const TARGET_RTP = Object.freeze({ ...calibration.targets });
/**
 * King Earth slot engine.
 *
 * The presentation keeps its legacy `dice_*` socket contract, while the game
 * maths follows Poseidon: 6x5 scatter pays, 8+ symbols win, winning symbols
 * tumble, and multiplier plaques remain in place until the sequence ends.
 */
const { createSeededRng } = require("./seededRng");

const COLS = 6;
const ROWS = 5;
const REGULAR_SYMBOLS = 8;
const MULTIPLIER = 8;
// Stable symbol IDs for multiplier artwork.
const MULTIPLIER_VALUES = [2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** Scatter jackpot — 3+ on finalGrid opens the match-3 scratch round. */
const JACKPOT = REGULAR_SYMBOLS + MULTIPLIER_VALUES.length; // 17
const JACKPOT_APPEARANCE_PROBABILITY = 0.18;
const JACKPOT_WIN_PROBABILITY = 0.0001;
const NATURAL_BONUS_PROBABILITY = 0.004;
const JACKPOT_MIN_SYMBOLS = 3;
// Kept as the bonus counter name. The character head (not multiplier plaques)
// is the free-spins scatter: 4 in the base game, 3 during free spins.
const HEAD = JACKPOT + 1; // 18
const HEAD_WEIGHT_BASE = 1.0;
const HEAD_WEIGHT_BONUS = 1.7;
const SCATTER = HEAD;
const SYMBOL_COUNT = HEAD + 1;
const FREE_SPINS_AWARD = 10;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;
const RETRIGGER_MIN_SCATTER = 3;
// Existing purchase prices. V4 calibrates symbol-generation probabilities;
// the published payout formulas are never scaled down.
const BUY_COST_MULT = 154;
const SUPER_BUY_COST_MULT = BUY_COST_MULT * 10;
const SUPER_MULTIPLIER_MIN = 20;
const MAX_WIN_MULTIPLIER = 5000;
const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MIN_MATCH = 8;

// Kept as aliases because the socket/client response historically calls the
// head-scatter counter `scatterCount`. Multiplier plaques no longer open bonus.
const GEM_SYMBOLS = [0, 1, 2, 3];

// Payout increases for every matching symbol above eight.
// Asset IDs are unchanged: letters 0..3, BOOK 4, RING 5, CUP 6, CROWN 7.
// A coefficient is a fraction of the triggering bet, before the plaque/bank.
const PAY_RULES = Object.freeze({
  0: Object.freeze({ start: 0.8, increment: 0.1 }),
  1: Object.freeze({ start: 0.8, increment: 0.1 }),
  2: Object.freeze({ start: 0.8, increment: 0.1 }),
  3: Object.freeze({ start: 0.8, increment: 0.1 }),
  4: Object.freeze({ start: 1.1, increment: 0.3 }),
  5: Object.freeze({ start: 1.4, increment: 0.35 }),
  6: Object.freeze({ start: 1.1, increment: 0.2 }),
  7: Object.freeze({ start: 2, increment: 0.5 }),
});
const PAYTABLE = Object.freeze(Object.fromEntries(Object.keys(PAY_RULES).map(symbol =>
  [symbol, Object.freeze(Array.from({ length: COLS * ROWS - MIN_MATCH + 1 }, (_, i) => symbolMultiplier(symbol, MIN_MATCH + i))) ])));
// Retain the existing regular-symbol mix. Bonus mode favors letters.
const BASE_WEIGHTS = [
  8, 8, 8, 8,
  8, 8, 8, 8,
];
const FREESPIN_WEIGHTS = [
  11.0, 11.0, 11.0, 11.0,
  6.2, 5.4, 4.4, 3.2,
];
// Absolute percentages PER SPIN, not per cell or conditional on winning.
// Static, independently calibrated mode tables. Remaining mass means no plaque.
const BASE_MULTIPLIER_WEIGHTS = Object.freeze([...calibration.multiplierWeights.base]);
const BONUS_MULTIPLIER_WEIGHTS = Object.freeze([...calibration.multiplierWeights.bonus]);
const SUPER_MULTIPLIER_WEIGHTS = Object.freeze([...calibration.multiplierWeights.super]);
if (calibration.version !== ECONOMY_VERSION || SUPER_MULTIPLIER_WEIGHTS.slice(0,3).some(w => w !== 0)) {
  throw new Error("INVALID_ZEUS_V4_PROFILE");
}
for (const weights of [BASE_MULTIPLIER_WEIGHTS, BONUS_MULTIPLIER_WEIGHTS, SUPER_MULTIPLIER_WEIGHTS]) {
  if (weights.length !== MULTIPLIER_VALUES.length || weights.some(w => !Number.isFinite(w) || w < 0) || weights.reduce((a,b) => a+b,0) > 100) {
    throw new Error("INVALID_ZEUS_V4_PROBABILITIES");
  }
}
// Pay exactly the published per-symbol formula in every mode.
const BASE_PAY_SCALE = 1;
const FREESPIN_PAY_SCALE = 1;
// The ball and the payout use the full plaque sum. There is no bank ceiling.
// A single spin is still bounded by MAX_WIN_MULTIPLIER × bet.
const BONUS_BANK_CAP = Number.POSITIVE_INFINITY;
const SUPER_BONUS_BANK_CAP = Number.POSITIVE_INFINITY;
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
  const weights = superBonus ? SUPER_MULTIPLIER_WEIGHTS : bonus ? BONUS_MULTIPLIER_WEIGHTS : BASE_MULTIPLIER_WEIGHTS;
  let roll = rng() * 100;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return MULTIPLIER_VALUES[i];
  }
  return null;
}
function isJackpot(symbol) {
  return symbol === JACKPOT;
}

function isHead(symbol) { return symbol === HEAD; }
function headCells(grid) {
  const cells = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (isHead(grid[c][r])) cells.push({ col: c, row: r });
  return cells;
}
function pickSymbol(rng, isFreeSpin, headsAllowed = true) {
  const headWeight = isFreeSpin ? HEAD_WEIGHT_BONUS : HEAD_WEIGHT_BASE;
  const regular = isFreeSpin ? FREESPIN_WEIGHTS : BASE_WEIGHTS;
  const choice = weightedIndex(rng, [...regular, headsAllowed ? headWeight : 0]);
  if (choice < REGULAR_SYMBOLS) return choice;
  return HEAD;
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
  const face = pickMultiplierValue(rng, volatility, { bonus: isFreeSpin, superBonus: isFreeSpin && superBonus });
  const jackpotRoll = rng();
  const jackpotCount = jackpotRoll < JACKPOT_WIN_PROBABILITY ? 3
    : jackpotRoll < JACKPOT_APPEARANCE_PROBABILITY ? (rng() < 0.5 ? 1 : 2) : 0;
  const naturalBonus = !isFreeSpin && rng() < NATURAL_BONUS_PROBABILITY;
  const special = [];
  if (face !== null) special.push(MULTIPLIER + MULTIPLIER_VALUES.indexOf(face));
  special.push(...Array(jackpotCount).fill(JACKPOT));
  if (naturalBonus) special.push(...Array(4).fill(HEAD));
  // Sample positions without replacement, before drawing regular symbols.
  const positions = Array.from({ length: COLS * ROWS }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const scheduled = new Map(special.map((symbol, i) => [positions[i], symbol]));
  const grid = Array.from({ length: COLS }, () => Array(ROWS));
  let heads = naturalBonus ? 4 : 0;
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
    const scheduledSymbol = scheduled.get(c * ROWS + r);
    if (scheduledSymbol !== undefined) grid[c][r] = scheduledSymbol;
    else {
      const symbol = pickSymbol(rng, isFreeSpin, isFreeSpin || heads < 3);
      if (isHead(symbol)) heads++;
      grid[c][r] = symbol;
    }
  }
  return grid;
}
function symbolMultiplier(symbol, count) {
  const rule = PAY_RULES[symbol];
  if (!rule || !Number.isInteger(count) || count < MIN_MATCH || count > COLS * ROWS) return 0;
  return Math.round((rule.start + (count - MIN_MATCH) * rule.increment) * 10000) / 10000;
}
function findPayAnywhereWins(grid, stake, payScale = 1) {
  const wins = [], winningCells = new Set();
  for (let symbol = 0; symbol < REGULAR_SYMBOLS; symbol++) {
    const cells = []; for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === symbol) cells.push({ col: c, row: r });
    const multiplier = symbolMultiplier(symbol, cells.length); if (!multiplier) continue;
    cells.forEach((cell) => winningCells.add(`${cell.col},${cell.row}`));
    wins.push({ type: "pay_anywhere", symbol, count: cells.length, multiplier, win: roundMoney(stake * multiplier * payScale), cells });
  }
  return { wins, winningCells };
}
function multiplierCells(grid) { const cells = []; for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) { const value = multiplierValue(grid[c][r]); if (value) cells.push({ col: c, row: r, value }); } return cells; }
function collapseGrid(grid, removed, rng, volatility, doubleChance, isFreeSpin, superBonus = false) {
  const next = [], incomingCounts = [];
  let heads = headCells(grid).length;
  for (let c = 0; c < COLS; c++) {
    const survivors = grid[c].filter((_, r) => !removed.has(`${c},${r}`));
    const incoming = [];
    while (incoming.length + survivors.length < ROWS) {
      // Plaques and jackpots are already sampled once per spin and survive.
      // A non-triggering base spin cannot turn into a bonus during cascades.
      const symbol = pickSymbol(rng, isFreeSpin, isFreeSpin || heads < 3);
      if (isHead(symbol)) heads++;
      incoming.push(symbol);
    }
    incomingCounts[c] = incoming.length;
    next[c] = [...incoming, ...survivors];
  }
  return { grid: next, incomingCounts };
}
function appliedMultiplierFor(sum, isBonus) { return sum > 0 ? sum : 1; }
function resolvePayoutMultiplier({ baseWin = 0, plaqueSum = 0, carried = 0, isFreeSpin = false, bankCap = Infinity } = {}) {
  const win = Number(baseWin) > 0;
  const plaques = win ? Math.max(0, Number(plaqueSum) || 0) : 0;
  const prev = Math.max(0, Number(carried) || 0);
  const cap = Number.isFinite(bankCap) ? bankCap : Infinity;
  const nextCarried = isFreeSpin ? Math.min(cap, prev + plaques) : 0;
  // The bank is retained, but a win needs a NEW plaque to activate it.
  const pool = isFreeSpin ? nextCarried : plaques;
  const applied = win && plaques > 0 && pool > 0 ? pool : 1;
  return { applied, nextCarried, plaques };
}
function classifyWinType(total, stake) { const r = total / Math.max(stake, 1); return r >= 50 ? "mega" : r >= 12 ? "big" : "normal"; }
function runTumbles(initialGrid, rng, options) {
  let grid = cloneGrid(initialGrid), baseWin = 0; const lineWins = [], winningCells = new Set(), cascadeSteps = [];
  for (let index = 0; index < MAX_TUMBLES; index++) {
    const beforeGrid = cloneGrid(grid), { wins, winningCells: stepKeys } = findPayAnywhereWins(grid, options.stake, options.payScale);
    if (!wins.length) break;
    const stepWin = roundMoney(wins.reduce((sum, w) => sum + w.win, 0)); baseWin = roundMoney(baseWin + stepWin);
    const collapsed = collapseGrid(grid, stepKeys, rng, options.volatility, options.doubleChance, options.isFreeSpin, options.superBonus);
    const afterGrid = collapsed.grid;
    stepKeys.forEach((key) => winningCells.add(key)); lineWins.push(...wins);
    cascadeSteps.push({ phase: "tumble", index, grid: beforeGrid, afterGrid: cloneGrid(afterGrid), win: stepWin, wins, cells: [...stepKeys].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), multiplierHits: multiplierCells(afterGrid), multiplierTotal: multiplierCells(afterGrid).reduce((sum, m) => sum + m.value, 0) });
    grid = afterGrid;
  }
  const plaques = multiplierCells(grid), collected = plaques.reduce((sum, p) => sum + p.value, 0);
  // Same as Poseidon: plaques only multiply a tumble win — never a zero-win spin.
  // Bonus: winning plaques bank into the session total and carry forward.
  const resolved = resolvePayoutMultiplier({
    baseWin,
    plaqueSum: collected,
    carried: options.isFreeSpin ? Number(options.freeSpinMultiplier) || 0 : 0,
    isFreeSpin: !!options.isFreeSpin,
    bankCap: options.superBonus ? SUPER_BONUS_BANK_CAP : BONUS_BANK_CAP,
  });
  return { finalGrid: grid, baseWin, collectedMultiplier: collected, appliedMultiplier: resolved.applied, nextFreeSpinMultiplier: resolved.nextCarried, multipliedWin: roundMoney(baseWin * resolved.applied), lineWins, winningCells, cascadeSteps };
}
function calculateWins(grid, stake, freeSpinMultiplier = 0) { const { wins, winningCells } = findPayAnywhereWins(grid, stake); const totalWin = wins.reduce((sum, w) => sum + w.win, 0); return { totalWin: roundMoney(totalWin), winningCells: [...winningCells].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), lineWins: wins, scatterCount: headCells(grid).length }; }
function spin(baseBet, options = {}) {
  const version = options.economyVersion ?? ECONOMY_VERSION;
  if (version === 1) return require("./DiceEngine.v1").spin(baseBet, options);
  if (version === 2) return require("./DiceEngine.v2").spin(baseBet, options);
  if (version === 3) return require("./DiceEngine.v3").spin(baseBet, options);
  if (version === 5) return require("./DiceEngine.v5").spin(baseBet, options);
  // Never fall through: a session pinned to an unknown engine must not be
  // dealt a different game.
  if (version !== 4) throw new Error(`UNKNOWN_ZEUS_ECONOMY_VERSION:${version}`);
  const rng = options.rng || createSeededRng(options.serverSeed, options.clientSeed, options.nonce), isFreeSpin = !!options.isFreeSpin, superBonus = !!(isFreeSpin && options.superBonus), stake = roundMoney(baseBet);
  const initialGrid = generateGrid(rng, options.volatility, false, isFreeSpin, superBonus);
  const tumble = runTumbles(initialGrid, rng, { stake, volatility: normalizeVolatility(options.volatility), doubleChance: false, isFreeSpin, superBonus, freeSpinMultiplier: options.freeSpinMultiplier, payScale: 1 });
  const scatterCount = headCells(tumble.finalGrid).length, winCap = roundMoney(MAX_WIN_MULTIPLIER * stake);
  const totalWin = Math.min(tumble.multipliedWin, winCap);
  const jackpotSymbolCount = countJackpotSymbols(tumble.finalGrid);
  return { economyVersion: ECONOMY_VERSION, grid: initialGrid, initialGrid, finalGrid: tumble.finalGrid, stake, baseBet: stake, doubleChance: false, isFreeSpin, freeSpinPayoutMult: 1, volatility: normalizeVolatility(options.volatility), nearMiss: false, almostBonus: !isFreeSpin && scatterCount === 3, capped: tumble.multipliedWin > winCap, maxWin: winCap, totalWin, baseWin: tumble.baseWin, winningCells: [...tumble.winningCells].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), lineWins: tumble.lineWins, scatterCount, jackpotSymbolCount, jackpotTriggered: jackpotSymbolCount >= JACKPOT_MIN_SYMBOLS, winType: classifyWinType(totalWin, stake), cascadeSteps: tumble.cascadeSteps, multipliers: { collected: tumble.collectedMultiplier, applied: tumble.appliedMultiplier, freeSpinTotal: tumble.nextFreeSpinMultiplier }, freeSpinsAwarded: !isFreeSpin && scatterCount >= 4 ? FREE_SPINS_AWARD : 0 };
}
module.exports = { findPayAnywhereWins, multiplierCells, headCells, cloneGrid, roundMoney, TARGET_RTP, ECONOMY_VERSION, PAY_RULES, SUPER_MULTIPLIER_WEIGHTS, JACKPOT_APPEARANCE_PROBABILITY, JACKPOT_WIN_PROBABILITY, NATURAL_BONUS_PROBABILITY, COLS, ROWS, MIN_MATCH, REGULAR_SYMBOLS, SYMBOL_COUNT, SCATTER, HEAD, HEAD_WEIGHT_BASE, HEAD_WEIGHT_BONUS, MULTIPLIER, JACKPOT, JACKPOT_MIN_SYMBOLS, GEM_SYMBOLS, FREE_SPINS_AWARD, FREE_SPINS_BOUGHT, RETRIGGER_AWARD, RETRIGGER_MIN_SCATTER, BUY_COST_MULT, SUPER_BUY_COST_MULT, SUPER_MULTIPLIER_MIN, MAX_WIN_MULTIPLIER, BET_MIN, BET_MAX, PAYTABLE, MULTIPLIER_VALUES, BASE_WEIGHTS, FREESPIN_WEIGHTS, BASE_PAY_SCALE, FREESPIN_PAY_SCALE, BONUS_BANK_CAP, SUPER_BONUS_BANK_CAP, BASE_MULTIPLIER_WEIGHTS, BONUS_MULTIPLIER_WEIGHTS, APPLIED_MULTIPLIER_CAP_BASE, APPLIED_MULTIPLIER_CAP_BONUS, appliedMultiplierFor, resolvePayoutMultiplier, normalizeVolatility, pickMultiplierValue, symbolMultiplier, isJackpot, isHead, countJackpotSymbols, generateGrid, calculateWins, spin, classifyWinType };
