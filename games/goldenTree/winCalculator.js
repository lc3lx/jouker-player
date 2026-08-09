const {
  REEL_COUNT,
  ROW_COUNT,
  PAYTABLE,
  REFERENCE_BET,
  SYMBOLS,
  WILD_ROW,
  MIN_CONSECUTIVE,
  minMatchCount,
  isLineBreaker,
  roundMoney,
} = require("./constants");

/**
 * Each landed wild tree expands over its whole reel (all rows) for win
 * evaluation, substituting every symbol on that reel except scatter and
 * jackpot symbols. Used in bonus mode only.
 */
function applyExpandingWilds(matrix, wildMultipliers) {
  const expandedReels = new Set(Object.keys(wildMultipliers).map(Number));
  const expanded = matrix.map((col) => [...col]);

  for (const reel of expandedReels) {
    const column = expanded[reel];
    if (!column) continue;
    for (let row = 0; row < column.length; row += 1) {
      if (!isLineBreaker(column[row])) {
        column[row] = SYMBOLS.WILD;
      }
    }
  }

  return { matrix: expanded, expandedReels };
}

/**
 * Left-to-right match on one horizontal strip (wild substitutes in-cell).
 */
function matchPayline(symbols) {
  let base = null;
  let count = 0;

  for (const sym of symbols) {
    if (sym === SYMBOLS.WILD) {
      count += 1;
      continue;
    }
    if (base === null) {
      base = sym;
      count += 1;
    } else if (sym === base) {
      count += 1;
    } else {
      break;
    }
  }

  if (count === 0) return null;
  const paySymbol = base || SYMBOLS.SEVEN;
  if (count < minMatchCount(paySymbol)) return null;
  return { count, symbol: paySymbol };
}

function basePayout(symbol, count, betAmount) {
  const table = PAYTABLE[symbol];
  if (!table || count < minMatchCount(symbol)) return 0;
  const idx = Math.min(count, table.length - 1);
  return roundMoney(table[idx] * (betAmount / REFERENCE_BET));
}

function wildMultiplierSum(positions, matrix, wildMultipliers, bonusMode) {
  if (!bonusMode) return 1;

  let sum = 0;
  for (const { col, row } of positions) {
    if (matrix[col][row] === SYMBOLS.WILD) {
      sum += wildMultipliers[col] || 2;
    }
  }
  return sum > 0 ? sum : 1;
}

/**
 * Strict rule: positions stay on ONE row, consecutive reels from 0, no gaps.
 * (No diagonals, no mid-board starts, no “count anywhere”.)
 */
function isContiguousFromCol0(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return false;
  const row0 = positions[0].row;
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (!p || p.col !== i) return false;
    if (!Number.isInteger(p.row) || p.row < 0 || p.row >= ROW_COUNT) {
      return false;
    }
    if (p.row !== row0) return false;
  }
  return true;
}

function pathMatchesMatrix(positions, symbol, matrix) {
  if (!isContiguousFromCol0(positions)) return false;
  if (positions.length < MIN_CONSECUTIVE) return false;
  for (const { col, row } of positions) {
    const cell = matrix[col]?.[row];
    if (cell == null) return false;
    if (isLineBreaker(cell)) return false;
    if (cell !== symbol && cell !== SYMBOLS.WILD) return false;
  }
  return true;
}

function cellContinues(sym, baseSymbol) {
  if (isLineBreaker(sym)) return { ok: false, base: baseSymbol };
  if (sym === SYMBOLS.WILD) return { ok: true, base: baseSymbol };
  if (baseSymbol === null) return { ok: true, base: sym };
  if (sym === baseSymbol) return { ok: true, base: baseSymbol };
  return { ok: false, base: baseSymbol };
}

/**
 * One horizontal run per row, starting at reel 0 only.
 * Stops at the first gap / foreign symbol. Needs ≥ MIN_CONSECUTIVE.
 */
function collectContiguousWins(evalMatrix) {
  const found = [];

  for (let row = 0; row < ROW_COUNT; row += 1) {
    let base = null;
    const positions = [];

    for (let col = 0; col < REEL_COUNT; col += 1) {
      const sym = evalMatrix[col][row];
      const step = cellContinues(sym, base);
      if (!step.ok) break;
      base = step.base;
      positions.push({ col, row });
    }

    const paySymbol = base || SYMBOLS.SEVEN;
    if (positions.length < minMatchCount(paySymbol)) continue;
    if (!pathMatchesMatrix(positions, paySymbol, evalMatrix)) continue;
    found.push({
      symbol: paySymbol,
      count: positions.length,
      positions: positions.slice(),
    });
  }

  return found;
}

/** Landscape: matrix[reel][row]. Auto-transposes mistaken 3×5 row-major. */
function normalizeLandscapeMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return Array.from({ length: REEL_COUNT }, () =>
      Array(ROW_COUNT).fill(SYMBOLS.CHERRY),
    );
  }

  if (
    matrix.length === ROW_COUNT &&
    matrix.every((row) => Array.isArray(row) && row.length === REEL_COUNT)
  ) {
    const out = Array.from({ length: REEL_COUNT }, () => Array(ROW_COUNT));
    for (let row = 0; row < ROW_COUNT; row += 1) {
      for (let reel = 0; reel < REEL_COUNT; reel += 1) {
        out[reel][row] = matrix[row][reel];
      }
    }
    return out;
  }

  const out = [];
  for (let reel = 0; reel < REEL_COUNT; reel += 1) {
    const src = Array.isArray(matrix[reel]) ? matrix[reel] : [];
    const col = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      col.push(src[row] != null ? src[row] : SYMBOLS.CHERRY);
    }
    out.push(col);
  }
  return out;
}

/**
 * Horizontal line wins (≥3 from reel 0, same row) + scatters.
 * One best win kept per symbol. Backend is sole payout authority.
 */
function calculateWins(matrix, wildMultipliers, betAmount, options = {}) {
  const bonusMode = options.bonusMode === true;
  const landed = normalizeLandscapeMatrix(matrix);

  let evalMatrix;
  let expandedReels;

  if (bonusMode) {
    const expanded = applyExpandingWilds(landed, wildMultipliers);
    evalMatrix = expanded.matrix;
    expandedReels = expanded.expandedReels;
  } else {
    evalMatrix = landed.map((col) => [...col]);
    expandedReels = new Set();
  }

  const bestBySymbol = new Map();
  const candidates = collectContiguousWins(evalMatrix);

  for (let i = 0; i < candidates.length; i += 1) {
    const { symbol, count, positions } = candidates[i];
    if (count !== positions.length) continue;
    if (!pathMatchesMatrix(positions, symbol, evalMatrix)) continue;

    const base = basePayout(symbol, count, betAmount);
    if (base <= 0) continue;

    const mult = wildMultiplierSum(
      positions,
      evalMatrix,
      wildMultipliers,
      bonusMode,
    );
    const amount = roundMoney(base * mult);
    const candidate = {
      symbol,
      count,
      positions,
      baseAmount: base,
      wildMultiplier: mult,
      amount,
    };

    const prev = bestBySymbol.get(symbol);
    if (
      !prev ||
      candidate.amount > prev.amount ||
      (candidate.amount === prev.amount && candidate.count > prev.count)
    ) {
      bestBySymbol.set(symbol, candidate);
    }
  }

  const lineWins = [];
  let lineTotal = 0;
  for (const win of bestBySymbol.values()) {
    lineTotal = roundMoney(lineTotal + win.amount);
    lineWins.push({
      lineIndex: lineWins.length,
      ...win,
    });
  }

  const scatterWins = [];
  const scatterTotal = 0;

  const totalWin = roundMoney(lineTotal + scatterTotal);

  const expandedWilds = bonusMode
    ? [...expandedReels].sort().map((reel) => ({
        reel,
        row: WILD_ROW,
        multiplier: wildMultipliers[reel] || 2,
      }))
    : [];

  return {
    expandedMatrix: evalMatrix,
    expandedWilds,
    lineWins,
    scatterWins,
    lineWinTotal: lineTotal,
    scatterWinTotal: scatterTotal,
    totalWin,
  };
}

module.exports = {
  applyExpandingWilds,
  calculateWins,
  matchPayline,
  basePayout,
  collectContiguousWins,
  isContiguousFromCol0,
  pathMatchesMatrix,
  normalizeLandscapeMatrix,
};
