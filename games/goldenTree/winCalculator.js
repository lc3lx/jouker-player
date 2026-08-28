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

function wildMultiplierSum(positions, matrix, wildMultipliers) {
  let sum = 0;
  for (const { col, row } of positions) {
    if (matrix[col][row] === SYMBOLS.WILD) {
      sum += wildMultipliers[col] || 2;
    }
  }
  return sum > 0 ? sum : 1;
}

/**
 * Contiguous L→R path from reel 0: each step lands on the next reel and
 * touches the previous cell (same row, edge, or corner — |Δrow| ≤ 1).
 */
function isContiguousFromCol0(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return false;
  for (let i = 0; i < positions.length; i += 1) {
    const p = positions[i];
    if (!p || p.col !== i) return false;
    if (!Number.isInteger(p.row) || p.row < 0 || p.row >= ROW_COUNT) {
      return false;
    }
    if (i > 0 && Math.abs(p.row - positions[i - 1].row) > 1) {
      return false;
    }
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

function pathKey(symbol, positions) {
  return `${symbol}:${positions.map((p) => `${p.col},${p.row}`).join(">")}`;
}

function isPrefixPath(shortPos, longPos) {
  if (shortPos.length >= longPos.length) return false;
  for (let i = 0; i < shortPos.length; i += 1) {
    if (
      shortPos[i].col !== longPos[i].col ||
      shortPos[i].row !== longPos[i].row
    ) {
      return false;
    }
  }
  return true;
}

/** Drop 3-in-a-row prefixes of a longer 4/5 run so a 5-oak is not also a 3+4. */
function keepMaximalPaths(found) {
  const seen = new Set();
  const unique = [];
  for (const hit of found) {
    const key = pathKey(hit.symbol, hit.positions);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique.filter(
    (a) =>
      !unique.some(
        (b) =>
          a !== b &&
          a.symbol === b.symbol &&
          isPrefixPath(a.positions, b.positions),
      ),
  );
}

/**
 * Collect L→R adjacent paths (incl. corner touch) starting on reel 0.
 * Every geometrically distinct maximal path is a separate win.
 */
function collectContiguousWins(evalMatrix) {
  const found = [];

  function walk(col, row, base, positions) {
    if (positions.length >= MIN_CONSECUTIVE) {
      const paySymbol = base || SYMBOLS.SEVEN;
      if (positions.length >= minMatchCount(paySymbol)) {
        found.push({
          symbol: paySymbol,
          count: positions.length,
          positions: positions.slice(),
        });
      }
    }

    const nextCol = col + 1;
    if (nextCol >= REEL_COUNT) return;

    for (let dr = -1; dr <= 1; dr += 1) {
      const nextRow = row + dr;
      if (nextRow < 0 || nextRow >= ROW_COUNT) continue;
      const sym = evalMatrix[nextCol][nextRow];
      const step = cellContinues(sym, base);
      if (!step.ok) continue;
      positions.push({ col: nextCol, row: nextRow });
      walk(nextCol, nextRow, step.base, positions);
      positions.pop();
    }
  }

  for (let row = 0; row < ROW_COUNT; row += 1) {
    const sym = evalMatrix[0][row];
    const step = cellContinues(sym, null);
    if (!step.ok) continue;
    walk(0, row, step.base, [{ col: 0, row }]);
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
 * Adjacent-path wins (≥3 from reel 0, corner/edge touch OK) + scatters.
 * Every maximal L→R path pays (middle row, 45° diagonal, zig-zag, …).
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

  const candidates = keepMaximalPaths(collectContiguousWins(evalMatrix));
  const payable = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const { symbol, count, positions } = candidates[i];
    if (count !== positions.length) continue;
    if (!pathMatchesMatrix(positions, symbol, evalMatrix)) continue;

    const base = basePayout(symbol, count, betAmount);
    if (base <= 0) continue;

    const mult = wildMultiplierSum(positions, evalMatrix, wildMultipliers);
    const amount = roundMoney(base * mult);
    payable.push({
      symbol,
      count,
      positions,
      baseAmount: base,
      wildMultiplier: mult,
      amount,
    });
  }

  payable.sort((a, b) => {
    const rowA = a.positions[0]?.row ?? 0;
    const rowB = b.positions[0]?.row ?? 0;
    if (rowA !== rowB) return rowA - rowB;
    const keyA = pathKey(a.symbol, a.positions);
    const keyB = pathKey(b.symbol, b.positions);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  const lineWins = [];
  let lineTotal = 0;
  for (const win of payable) {
    lineTotal = roundMoney(lineTotal + win.amount);
    lineWins.push({
      lineIndex: lineWins.length,
      ...win,
    });
  }

  const scatterWins = [];
  const scatterTotal = 0;

  const totalWin = roundMoney(lineTotal + scatterTotal);

  // Always report landed trees + multipliers so the client can show treex art.
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
  matchPayline,
  basePayout,
  collectContiguousWins,
  keepMaximalPaths,
  isContiguousFromCol0,
  pathMatchesMatrix,
  normalizeLandscapeMatrix,
};
