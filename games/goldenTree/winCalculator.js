const {
  REEL_COUNT,
  ROW_COUNT,
  PAYTABLE,
  STAR_REELS,
  STAR_SCATTER_PAY,
  DOLLAR_SCATTER_PAY,
  REFERENCE_BET,
  SYMBOLS,
  WILD_ROW,
  minMatchCount,
  isScatter,
  isLineBreaker,
  roundMoney,
} = require("./constants");

/**
 * Each landed wild tree expands over its whole reel (all rows) for win
 * evaluation, substituting every symbol on that reel except scatter and
 * jackpot symbols.
 * Used in bonus mode only.
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
 * Left-to-right path match parser (wild substitutes in-cell).
 * Kept for unit tests / helpers; win eval uses walkFromCol0.
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

/**
 * Wild multipliers on winning positions ADD together (e.g. x2 + x3 = x5).
 * Main game connector wilds have no multipliers (treated as ×1).
 */
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

function positionsKey(symbol, positions) {
  return `${symbol}|${positions.map((p) => `${p.col},${p.row}`).join(";")}`;
}

/**
 * Contiguous L→R from col 0 only: positions[i].col === i.
 * Each next position must touch the prior one horizontally or diagonally, so
 * its row may differ by at most one. Any skipped column is rejected.
 */
function isContiguousFromCol0(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return false;
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (!p || p.col !== i) return false;
    if (!Number.isInteger(p.row) || p.row < 0 || p.row >= ROW_COUNT) {
      return false;
    }
    if (i > 0 && Math.abs(p.row - positions[i - 1].row) > 1) return false;
  }
  return true;
}

/**
 * Every cell on the path must be [symbol] or wild (no foreign symbols / gaps).
 */
function pathMatchesMatrix(positions, symbol, matrix) {
  if (!isContiguousFromCol0(positions)) return false;
  for (const { col, row } of positions) {
    const cell = matrix[col]?.[row];
    if (cell == null) return false;
    if (isLineBreaker(cell)) return false;
    if (cell !== symbol && cell !== SYMBOLS.WILD) return false;
  }
  return true;
}

/**
 * Can this cell continue a run for [baseSymbol] (null = unresolved, all-wild so far)?
 */
function cellContinues(sym, baseSymbol) {
  if (isLineBreaker(sym)) return { ok: false, base: baseSymbol };
  if (sym === SYMBOLS.WILD) return { ok: true, base: baseSymbol };
  if (baseSymbol === null) return { ok: true, base: sym };
  if (sym === baseSymbol) return { ok: true, base: baseSymbol };
  return { ok: false, base: baseSymbol };
}

/**
 * Walk contiguous paths starting ONLY at column 0.
 * Extends to the next column when a matching symbol/wild appears in the same
 * row or a touching diagonal row. First column with no valid extension ends
 * that path (no skipping).
 */
function collectContiguousWins(evalMatrix) {
  const found = [];

  function record(baseSymbol, positions) {
    const paySymbol = baseSymbol || SYMBOLS.SEVEN;
    const count = positions.length;
    if (count < minMatchCount(paySymbol)) return;
    if (!pathMatchesMatrix(positions, paySymbol, evalMatrix)) return;
    found.push({ symbol: paySymbol, count, positions: positions.slice() });
  }

  function dfs(col, row, baseSymbol, positions) {
    const atEnd = col >= REEL_COUNT - 1;
    let extended = false;

    if (!atEnd) {
      const firstNextRow = Math.max(0, row - 1);
      const lastNextRow = Math.min(ROW_COUNT - 1, row + 1);
      for (let nextRow = firstNextRow; nextRow <= lastNextRow; nextRow += 1) {
        const sym = evalMatrix[col + 1][nextRow];
        const step = cellContinues(sym, baseSymbol);
        if (!step.ok) continue;
        extended = true;
        dfs(col + 1, nextRow, step.base, [
          ...positions,
          { col: col + 1, row: nextRow },
        ]);
      }
    }

    // Maximal path only: record when we cannot extend further (gap / end).
    if (atEnd || !extended) {
      record(baseSymbol, positions);
    }
  }

  for (let startRow = 0; startRow < ROW_COUNT; startRow += 1) {
    const sym = evalMatrix[0][startRow];
    const step = cellContinues(sym, null);
    if (!step.ok) continue;
    dfs(0, startRow, step.base, [{ col: 0, row: startRow }]);
  }

  return found;
}

/**
 * Landscape layout: matrix[reel][row]
 * - reel 0..4 = columns left → right on the horizontal screen
 * - row 0..2 = top → bottom
 * Auto-transposes a mistaken 3×5 row-major payload.
 */
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
 * Contiguous wins from the leftmost reel (touching horizontal/diagonal cells)
 * plus scatters.
 * @param {object} [options]
 * @param {boolean} [options.bonusMode] — expanding wilds + multipliers
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

  const lineWins = [];
  let lineTotal = 0;
  const seen = new Set();

  const candidates = collectContiguousWins(evalMatrix);
  for (let i = 0; i < candidates.length; i += 1) {
    const { symbol, count, positions } = candidates[i];
    if (count !== positions.length) continue;
    if (!pathMatchesMatrix(positions, symbol, evalMatrix)) continue;

    const key = positionsKey(symbol, positions);
    if (seen.has(key)) continue;
    seen.add(key);

    const base = basePayout(symbol, count, betAmount);
    if (base <= 0) continue;

    const mult = wildMultiplierSum(
      positions,
      evalMatrix,
      wildMultipliers,
      bonusMode,
    );
    const amount = roundMoney(base * mult);

    lineTotal = roundMoney(lineTotal + amount);
    lineWins.push({
      lineIndex: lineWins.length,
      symbol,
      count,
      positions,
      baseAmount: base,
      wildMultiplier: mult,
      amount,
    });
  }

  const scatterWins = [];
  let scatterTotal = 0;

  let starCount = 0;
  for (const col of STAR_REELS) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (evalMatrix[col][row] === SYMBOLS.STAR) starCount += 1;
    }
  }
  if (starCount >= 3) {
    const amount = roundMoney(
      STAR_SCATTER_PAY[3] * (betAmount / REFERENCE_BET),
    );
    scatterTotal = roundMoney(scatterTotal + amount);
    scatterWins.push({ kind: SYMBOLS.STAR, count: starCount, amount });
  }

  let dollarCount = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (evalMatrix[col][row] === SYMBOLS.DOLLAR) dollarCount += 1;
    }
  }
  if (dollarCount >= 3) {
    const capped = Math.min(dollarCount, 5);
    const tablePay = DOLLAR_SCATTER_PAY[capped] || DOLLAR_SCATTER_PAY[5];
    const amount = roundMoney(tablePay * (betAmount / REFERENCE_BET));
    scatterTotal = roundMoney(scatterTotal + amount);
    scatterWins.push({ kind: SYMBOLS.DOLLAR, count: dollarCount, amount });
  }

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
