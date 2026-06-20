const {
  REEL_COUNT,
  ROW_COUNT,
  PAYLINES,
  PAYTABLE,
  STAR_REELS,
  STAR_SCATTER_PAY,
  DOLLAR_SCATTER_PAY,
  REFERENCE_BET,
  SYMBOLS,
  minMatchCount,
  isScatter,
  roundMoney,
} = require("./constants");

/**
 * Apply expanding wild: any reel with a wild multiplier covers the full column.
 */
function applyExpandingWilds(matrix, wildMultipliers) {
  const expanded = new Set(Object.keys(wildMultipliers).map(Number));
  const result = matrix.map((col) => [...col]);

  for (const col of expanded) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      result[col][row] = SYMBOLS.WILD;
    }
  }

  return { matrix: result, expandedReels: expanded };
}

/**
 * Resolve symbol on a payline cell after wild expansion.
 */
function effectiveSymbol(matrix, col, row, expandedReels) {
  if (expandedReels.has(col)) return SYMBOLS.WILD;
  return matrix[col][row];
}

/**
 * Left-to-right payline match parser.
 *
 * Walk each payline column by column:
 * - Scatter on the path breaks the line (scatters pay separately).
 * - Wild columns substitute for the first non-wild symbol seen.
 * - All-wild lines pay as SEVEN.
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
 */
function wildMultiplierSum(positions, expandedReels, wildMultipliers) {
  let sum = 0;
  for (const { col } of positions) {
    if (expandedReels.has(col)) {
      sum += wildMultipliers[col] || 2;
    }
  }
  return sum > 0 ? sum : 1;
}

/**
 * Evaluate all 10 paylines and scatter pays.
 */
function calculateWins(matrix, wildMultipliers, betAmount) {
  const { matrix: expandedMatrix, expandedReels } = applyExpandingWilds(
    matrix,
    wildMultipliers,
  );

  const lineWins = [];
  let lineTotal = 0;

  for (let lineIndex = 0; lineIndex < PAYLINES.length; lineIndex += 1) {
    const payline = PAYLINES[lineIndex];
    const symbols = [];
    const positions = [];

    for (let col = 0; col < REEL_COUNT; col += 1) {
      const row = payline[col];
      const raw = expandedMatrix[col][row];
      if (isScatter(raw)) break;

      symbols.push(effectiveSymbol(expandedMatrix, col, row, expandedReels));
      positions.push({ col, row });
    }

    if (symbols.length === 0) continue;

    const match = matchPayline(symbols);
    if (!match) continue;

    const winPositions = positions.slice(0, match.count);
    const base = basePayout(match.symbol, match.count, betAmount);
    if (base <= 0) continue;

    const mult = wildMultiplierSum(winPositions, expandedReels, wildMultipliers);
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
      if (expandedMatrix[col][row] === SYMBOLS.STAR) starCount += 1;
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
      if (expandedMatrix[col][row] === SYMBOLS.DOLLAR) dollarCount += 1;
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

  const expandedWilds = [...expandedReels].sort().map((reel) => ({
    reel,
    multiplier: wildMultipliers[reel] || 2,
  }));

  return {
    expandedMatrix,
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
