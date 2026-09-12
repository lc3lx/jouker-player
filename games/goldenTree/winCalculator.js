const {
  REEL_COUNT,
  ROW_COUNT,
  PAYTABLE,
  REFERENCE_BET,
  SYMBOLS,
  WILD_ROW,
  PAYLINES,
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
 * Evaluate a single fixed payline against the matrix.
 * Walk left-to-right: track the base symbol (first non-wild), wilds substitute.
 * Returns null if no win, otherwise { symbol, count, positions, lineIndex }.
 */
function evaluatePayline(payline, lineIndex, evalMatrix, wildMultipliers, betAmount) {
  let base = null;
  let count = 0;
  const positions = [];

  for (let col = 0; col < REEL_COUNT; col += 1) {
    const row = payline[col];
    if (row < 0 || row >= ROW_COUNT) break;
    const sym = evalMatrix[col]?.[row];
    if (sym == null) break;

    if (isLineBreaker(sym)) break;

    if (sym === SYMBOLS.WILD) {
      // Wild substitutes — don't lock the base symbol
      count += 1;
      positions.push({ col, row });
      continue;
    }

    if (base === null) {
      base = sym;
      count += 1;
      positions.push({ col, row });
    } else if (sym === base) {
      count += 1;
      positions.push({ col, row });
    } else {
      break;
    }
  }

  if (count === 0) return null;
  const paySymbol = base || SYMBOLS.SEVEN;
  if (count < minMatchCount(paySymbol)) return null;

  const base_payout = basePayout(paySymbol, count, betAmount);
  if (base_payout <= 0) return null;

  const mult = wildMultiplierSum(positions, evalMatrix, wildMultipliers);
  const amount = roundMoney(base_payout * mult);

  return {
    lineIndex,
    symbol: paySymbol,
    count,
    positions,
    baseAmount: base_payout,
    wildMultiplier: mult,
    amount,
  };
}

function basePayout(symbol, count, betAmount) {
  const table = PAYTABLE[symbol];
  if (!table || count < minMatchCount(symbol)) return 0;
  const idx = Math.min(count, table.length - 1);
  return roundMoney(table[idx] * (betAmount / REFERENCE_BET));
}

function wildMultiplierSum(positions, matrix, wildMultipliers) {
  let sum = 0;
  for (const { col, row } of positions) {
    if (matrix[col][row] === SYMBOLS.WILD) {
      const mult = wildMultipliers ? wildMultipliers[col] : 0;
      if (mult && mult > 1) {
        sum += mult;
      }
    }
  }
  return sum > 0 ? sum : 1;
}

/**
 * Check that positions follow a valid payline pattern starting from col 0.
 */
function isContiguousFromCol0(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return false;
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (!p || p.col !== i) return false;
    if (!Number.isInteger(p.row) || p.row < 0 || p.row >= ROW_COUNT) {
      return false;
    }
  }
  return true;
}

function pathMatchesMatrix(positions, symbol, matrix) {
  if (!isContiguousFromCol0(positions)) return false;
  if (positions.length < minMatchCount(symbol)) return false;
  for (const { col, row } of positions) {
    const cell = matrix[col]?.[row];
    if (cell == null) return false;
    if (isLineBreaker(cell)) return false;
    if (cell !== symbol && cell !== SYMBOLS.WILD) return false;
  }
  return true;
}

/**
 * Left-to-right match on one horizontal strip (wild substitutes in-cell).
 * Kept for backward compatibility with unit tests.
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
 * Fixed 10-payline evaluation. Each payline is evaluated left-to-right.
 * Seven requires only 2 consecutive; all others need 3.
 * Backend is sole payout authority.
 */
function calculateWins(matrix, wildMultipliers, betAmount, options = {}) {
  const bonusMode = options.bonusMode === true;
  const landed = normalizeLandscapeMatrix(matrix);

  let evalMatrix;

  if (bonusMode) {
    const expanded = applyExpandingWilds(landed, wildMultipliers);
    evalMatrix = expanded.matrix;
  } else {
    evalMatrix = landed.map((col) => [...col]);
  }

  const lineWins = [];
  let lineTotal = 0;

  for (let i = 0; i < PAYLINES.length; i += 1) {
    const win = evaluatePayline(PAYLINES[i], i, evalMatrix, wildMultipliers, betAmount);
    if (win) {
      lineTotal = roundMoney(lineTotal + win.amount);
      lineWins.push(win);
    }
  }

  const scatterWins = [];
  const scatterTotal = 0;

  const totalWin = roundMoney(lineTotal + scatterTotal);

  // Always report landed trees + multipliers so the client can show tree art.
  // `expands` is true only in bonus — main trees connect in-cell, no column fill.
  const expandedWilds = Object.keys(wildMultipliers)
    .map(Number)
    .filter((reel) => Number.isInteger(reel))
    .sort((a, b) => a - b)
    .map((reel) => ({
      reel,
      row: WILD_ROW,
      multiplier: wildMultipliers[reel] || 2,
      expands: bonusMode,
    }));

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
  evaluatePayline,
  matchPayline,
  basePayout,
  isContiguousFromCol0,
  pathMatchesMatrix,
  normalizeLandscapeMatrix,
};
