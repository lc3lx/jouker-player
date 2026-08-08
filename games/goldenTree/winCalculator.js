const {
  REEL_COUNT,
  ROW_COUNT,
  ADJACENT_PATHS,
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
 * evaluation, substituting every symbol on that reel except Scatters.
 * Used in bonus mode only.
 */
function applyExpandingWilds(matrix, wildMultipliers) {
  const expandedReels = new Set(Object.keys(wildMultipliers).map(Number));
  const expanded = matrix.map((col) => [...col]);

  for (const reel of expandedReels) {
    const column = expanded[reel];
    if (!column) continue;
    for (let row = 0; row < column.length; row += 1) {
      if (!isScatter(column[row])) {
        column[row] = SYMBOLS.WILD;
      }
    }
  }

  return { matrix: expanded, expandedReels };
}

/**
 * Left-to-right path match parser (wild substitutes in-cell).
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
 * Evaluate adjacent paths (|Δrow| ≤ 1) and scatter pays.
 * @param {object} [options]
 * @param {boolean} [options.bonusMode] — expanding wilds + multipliers
 */
function calculateWins(matrix, wildMultipliers, betAmount, options = {}) {
  const bonusMode = options.bonusMode === true;

  let evalMatrix;
  let expandedReels;

  if (bonusMode) {
    const expanded = applyExpandingWilds(matrix, wildMultipliers);
    evalMatrix = expanded.matrix;
    expandedReels = expanded.expandedReels;
  } else {
    evalMatrix = matrix.map((col) => [...col]);
    expandedReels = new Set();
  }

  const lineWins = [];
  let lineTotal = 0;
  const seen = new Set();

  for (let lineIndex = 0; lineIndex < ADJACENT_PATHS.length; lineIndex += 1) {
    const path = ADJACENT_PATHS[lineIndex];
    const symbols = [];
    const positions = [];

    for (let col = 0; col < REEL_COUNT; col += 1) {
      const row = path[col];
      const raw = evalMatrix[col][row];
      if (isLineBreaker(raw)) break;

      symbols.push(raw);
      positions.push({ col, row });
    }

    if (symbols.length === 0) continue;

    const match = matchPayline(symbols);
    if (!match) continue;

    const winPositions = positions.slice(0, match.count);
    const key = positionsKey(match.symbol, winPositions);
    if (seen.has(key)) continue;
    seen.add(key);

    const base = basePayout(match.symbol, match.count, betAmount);
    if (base <= 0) continue;

    const mult = wildMultiplierSum(
      winPositions,
      evalMatrix,
      wildMultipliers,
      bonusMode,
    );
    const amount = roundMoney(base * mult);

    lineTotal = roundMoney(lineTotal + amount);
    lineWins.push({
      lineIndex,
      symbol: match.symbol,
      count: match.count,
      positions: winPositions,
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
};
