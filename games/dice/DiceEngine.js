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
// Exact Poseidon plaque ladder and weighted face distribution.
const MULTIPLIER_VALUES = [2, 5, 10, 20, 50, 100, 200, 500, 1000];
/** Scatter jackpot — 3+ on finalGrid opens the match-3 scratch round. */
const JACKPOT = REGULAR_SYMBOLS + MULTIPLIER_VALUES.length; // 17
const JACKPOT_WEIGHT = 0.25;
const JACKPOT_MIN_SYMBOLS = 3;
// Kept as the bonus counter name. The character head (not multiplier plaques)
// is the free-spins scatter: 4 in the base game, 3 during free spins.
const HEAD = JACKPOT + 1; // 18
const HEAD_WEIGHT_BASE = 1.0;
const HEAD_WEIGHT_BONUS = 1.7;
const SCATTER = HEAD;
const SYMBOL_COUNT = HEAD + 1;
const FREE_SPINS_AWARD = 5;
const FREE_SPINS_BOUGHT = 10;
const RETRIGGER_AWARD = 5;
const RETRIGGER_MIN_SCATTER = 3;
// Priced off the measured return of a round — re-derive with tool/atlantisRtp.js.
const BUY_COST_MULT = 154;
const SUPER_BUY_COST_MULT = 784;
const SUPER_MULTIPLIER_MIN = 20;
const MAX_WIN_MULTIPLIER = 5000;
const BET_MIN = 10000;
const BET_MAX = 1000000000;
const MIN_MATCH = 8;

// Kept as aliases because the socket/client response historically calls the
// head-scatter counter `scatterCount`. Multiplier plaques no longer open bonus.
const GEM_SYMBOLS = [0, 1, 2, 3];

// A, E, N, S, book, ring, class, crown.  Bands: 8-9 / 10-11 / 12+ matches.
// These used to be Poseidon's numbers verbatim, but King Earth draws from 8
// symbol faces where Poseidon has 9, so the same grid hits 8-of-a-kind far more
// often and the shared values paid several times too much.  Tuned on its own
// with `node tool/atlantisRtp.js`.
const PAYTABLE = {
  0: [1.24, 1.42, 1.86], 1: [1.24, 1.42, 1.86],
  2: [1.24, 1.42, 1.86], 3: [1.24, 1.42, 1.86],
  4: [1.42, 1.86, 2.72], 5: [1.62, 2.29, 3.48],
  6: [1.86, 2.85, 4.34], 7: [2.48, 4.34, 6.2],
};
// Scaled from Poseidon's non-plaque mass.  King Earth has four supplied
// premium symbols rather than Poseidon's five, so scaling preserves the exact
// Poseidon probability of a plaque on every base/bonus draw.
// Letters are heavier so 8-of-a-kind lands often enough to feel like a
// normal spin, not a rare accident. Premiums stay lighter so the big
// symbols remain the rare hit.
const BASE_WEIGHTS = [
  8, 8, 8, 8,
  8, 8, 8, 8,
];
const FREESPIN_WEIGHTS = [
  11.0, 11.0, 11.0, 11.0,
  6.2, 5.4, 4.4, 3.2,
];
const BASE_MULTIPLIER_WEIGHTS = [82, 11, 4.2, 1.6, .7, .3, .12, .05, .02];
const BONUS_MULTIPLIER_WEIGHTS = [62, 16, 10, 5.5, 3, 1.8, .9, .45, .2];
const SUPPRESSED_MULTIPLIER_WEIGHTS = [88, 9, 2.2, .5, .15, .05, .015, .005, .002];
const MULTIPLIER_GATES = [.48, .35, .33, .32, .35, .4, .4, .35, .4];
const BIG_MULTIPLIER_THRESHOLD = 20;
// A plaque on a winning board pays. Stripping those wins put multipliers
// on screen that did nothing.
const PLAQUE_WIN_KEEP = 1;
// Pays the posted paytable. A hidden scale made an 8-letter win of 1.24×
// arrive as 0.16× before the multiplier (1612 instead of 12400 on a 10,000 bet).
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

function isHead(symbol) { return symbol === HEAD; }
function headCells(grid) {
  const cells = [];
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (isHead(grid[c][r])) cells.push({ col: c, row: r });
  return cells;
}
function pickSymbol(rng, isFreeSpin, bigAlready, superBonus = false) {
  // Bonus plaques are rarer than the base game so an uncapped bank
  // does not multiply every posted pay by ×60. Base cell rate stays
  // aligned with Poseidon (2.8 / 85.45).
  const plaqueWeight = isFreeSpin ? 0.42 : 0.55;
  const headWeight = isFreeSpin ? HEAD_WEIGHT_BONUS : HEAD_WEIGHT_BASE;
  const regular = isFreeSpin ? FREESPIN_WEIGHTS : BASE_WEIGHTS;
  const choice = weightedIndex(rng, [...regular, plaqueWeight, JACKPOT_WEIGHT, headWeight]);
  if (choice < REGULAR_SYMBOLS) return choice;
  if (choice === REGULAR_SYMBOLS) {
    const value = pickMultiplierValue(rng, "medium", { bonus: isFreeSpin, bigAlready, superBonus });
    return MULTIPLIER + MULTIPLIER_VALUES.indexOf(value);
  }
  if (choice === REGULAR_SYMBOLS + 1) return JACKPOT;
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
  const grid = []; let hasBig = false;
  for (let c = 0; c < COLS; c++) { grid[c] = []; for (let r = 0; r < ROWS; r++) { const s = pickSymbol(rng, isFreeSpin, hasBig, superBonus); if (multiplierValue(s) >= BIG_MULTIPLIER_THRESHOLD) hasBig = true; grid[c][r] = s; } }
  return grid;
}
function symbolMultiplier(symbol, count) {
  const bands = PAYTABLE[symbol] || [];
  if (count >= 12) return bands[2] || 0;
  if (count >= 10) return bands[1] || 0;
  if (count >= MIN_MATCH) return bands[0] || 0;
  return 0;
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
  const next = []; const incomingCounts = []; let hasBig = multiplierCells(grid).some((m) => m.value >= BIG_MULTIPLIER_THRESHOLD);
  for (let c = 0; c < COLS; c++) { const survivors = []; for (let r = 0; r < ROWS; r++) if (!removed.has(`${c},${r}`)) survivors.push(grid[c][r]); const incoming = []; while (incoming.length + survivors.length < ROWS) { const s = pickSymbol(rng, isFreeSpin, hasBig, superBonus); if (multiplierValue(s) >= BIG_MULTIPLIER_THRESHOLD) hasBig = true; incoming.push(s); } incomingCounts[c] = incoming.length; next[c] = [...incoming, ...survivors]; }
  return { grid: next, incomingCounts };
}
function softenPlaqueWins(grid, mutableRows, rng, isFreeSpin = false) {
  // Bought bonus spins must be allowed to pay. Stripping those wins left a
  // 10-spin purchase with a single hit.
  if (isFreeSpin) return;
  if (!multiplierCells(grid).length) return;
  if (rng() < PLAQUE_WIN_KEEP) return;
  for (let guard = 0; guard < 8; guard += 1) {
    const { wins } = findPayAnywhereWins(grid, 1);
    if (!wins.length) return;
    const counts = new Array(REGULAR_SYMBOLS).fill(0);
    for (let c = 0; c < COLS; c += 1) for (let r = 0; r < ROWS; r += 1) {
      const symbol = grid[c][r];
      if (symbol >= 0 && symbol < REGULAR_SYMBOLS) counts[symbol] += 1;
    }
    let progressed = false;
    for (const win of wins) {
      let extra = counts[win.symbol] - (MIN_MATCH - 1);
      if (extra <= 0) continue;
      for (let c = 0; c < COLS && extra > 0; c += 1) {
        const limit = mutableRows[c] || 0;
        for (let r = 0; r < limit && extra > 0; r += 1) {
          if (grid[c][r] !== win.symbol) continue;
          let replacement = -1;
          let bestN = Infinity;
          for (let symbol = 0; symbol < REGULAR_SYMBOLS; symbol += 1) {
            if (symbol === win.symbol || counts[symbol] >= MIN_MATCH - 1) continue;
            if (counts[symbol] < bestN) { bestN = counts[symbol]; replacement = symbol; }
          }
          if (replacement < 0) return;
          counts[win.symbol] -= 1;
          counts[replacement] += 1;
          grid[c][r] = replacement;
          extra -= 1;
          progressed = true;
        }
      }
    }
    if (!progressed) return;
  }
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
    const beforeGrid = cloneGrid(grid), { wins, winningCells: stepKeys } = findPayAnywhereWins(grid, options.stake, options.isFreeSpin ? FREESPIN_PAY_SCALE : BASE_PAY_SCALE);
    if (!wins.length) break;
    const stepWin = roundMoney(wins.reduce((sum, w) => sum + w.win, 0)); baseWin = roundMoney(baseWin + stepWin);
    const collapsed = collapseGrid(grid, stepKeys, rng, options.volatility, options.doubleChance, options.isFreeSpin, options.superBonus);
    softenPlaqueWins(collapsed.grid, collapsed.incomingCounts, rng, options.isFreeSpin);
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
  const rng = createSeededRng(options.serverSeed, options.clientSeed, options.nonce), isFreeSpin = !!options.isFreeSpin, superBonus = !!(isFreeSpin && options.superBonus), stake = roundMoney(baseBet);
  const initialGrid = generateGrid(rng, options.volatility, false, isFreeSpin, superBonus);
  softenPlaqueWins(initialGrid, Array(COLS).fill(ROWS), rng, isFreeSpin);
  const tumble = runTumbles(initialGrid, rng, { stake, volatility: normalizeVolatility(options.volatility), doubleChance: false, isFreeSpin, superBonus, freeSpinMultiplier: options.freeSpinMultiplier });
  const scatterCount = headCells(tumble.finalGrid).length, winCap = roundMoney(MAX_WIN_MULTIPLIER * stake);
  const totalWin = Math.min(tumble.multipliedWin, winCap);
  const jackpotSymbolCount = countJackpotSymbols(tumble.finalGrid);
  return { grid: initialGrid, initialGrid, finalGrid: tumble.finalGrid, stake, baseBet: stake, doubleChance: false, isFreeSpin, freeSpinPayoutMult: 1, volatility: normalizeVolatility(options.volatility), nearMiss: false, almostBonus: !isFreeSpin && scatterCount === 3, capped: tumble.multipliedWin > winCap, maxWin: winCap, totalWin, baseWin: tumble.baseWin, winningCells: [...tumble.winningCells].map((key) => { const [col, row] = key.split(",").map(Number); return { col, row }; }), lineWins: tumble.lineWins, scatterCount, jackpotSymbolCount, jackpotTriggered: jackpotSymbolCount >= JACKPOT_MIN_SYMBOLS, winType: classifyWinType(totalWin, stake), cascadeSteps: tumble.cascadeSteps, multipliers: { collected: tumble.collectedMultiplier, applied: tumble.appliedMultiplier, freeSpinTotal: tumble.nextFreeSpinMultiplier }, freeSpinsAwarded: !isFreeSpin && scatterCount >= 4 ? FREE_SPINS_AWARD : 0 };
}
module.exports = { COLS, ROWS, MIN_MATCH, REGULAR_SYMBOLS, SYMBOL_COUNT, SCATTER, HEAD, HEAD_WEIGHT_BASE, HEAD_WEIGHT_BONUS, MULTIPLIER, JACKPOT, JACKPOT_WEIGHT, JACKPOT_MIN_SYMBOLS, GEM_SYMBOLS, FREE_SPINS_AWARD, FREE_SPINS_BOUGHT, RETRIGGER_AWARD, RETRIGGER_MIN_SCATTER, BUY_COST_MULT, SUPER_BUY_COST_MULT, SUPER_MULTIPLIER_MIN, MAX_WIN_MULTIPLIER, BET_MIN, BET_MAX, PAYTABLE, MULTIPLIER_VALUES, BASE_WEIGHTS, FREESPIN_WEIGHTS, BASE_PAY_SCALE, FREESPIN_PAY_SCALE, BONUS_BANK_CAP, SUPER_BONUS_BANK_CAP, MULTIPLIER_GATES, BASE_MULTIPLIER_WEIGHTS, BONUS_MULTIPLIER_WEIGHTS, SUPPRESSED_MULTIPLIER_WEIGHTS, BIG_MULTIPLIER_THRESHOLD, APPLIED_MULTIPLIER_CAP_BASE, APPLIED_MULTIPLIER_CAP_BONUS, appliedMultiplierFor, resolvePayoutMultiplier, normalizeVolatility, pickMultiplierValue, symbolMultiplier, isJackpot, isHead, countJackpotSymbols, generateGrid, calculateWins, spin, classifyWinType };
