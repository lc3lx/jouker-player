"use strict";

const {
  roundMoney,
  SYMBOLS,
  STAR_REELS,
  STAR_SCATTER_PAY,
  DOLLAR_SCATTER_PAY,
  REFERENCE_BET,
  ROW_COUNT,
  REEL_COUNT,
  MIN_CONSECUTIVE,
  WIN_RULES_VERSION,
} = require("./constants");
const {
  calculateWins,
  pathMatchesMatrix,
  normalizeLandscapeMatrix,
  applyExpandingWilds,
  basePayout,
} = require("./winCalculator");
const logger = require("../../utils/logger");

/**
 * Defense-in-depth: never credit a win that does not match the landed grid.
 * Re-filters line/scatter wins and recomputes the payable total from the matrix.
 */
function hardenWinResult(matrix, wildMultipliers, betAmount, options = {}) {
  const bonusMode = options.bonusMode === true;
  const fresh = calculateWins(matrix, wildMultipliers, betAmount, { bonusMode });

  const landed = normalizeLandscapeMatrix(matrix);
  const evalMatrix = bonusMode
    ? applyExpandingWilds(landed, wildMultipliers).matrix
    : landed.map((col) => [...col]);

  const lineWins = [];
  let lineTotal = 0;
  for (const w of fresh.lineWins) {
    if (!w || w.count !== w.positions?.length) continue;
    // Same bar for orange, seven, cherry, … — never pay under 3-in-a-row.
    if (!Number.isInteger(w.count) || w.count < MIN_CONSECUTIVE) continue;
    // Reject mid-board / right-side clusters that never touch reel 0.
    const startsAtCol0 =
      Array.isArray(w.positions) &&
      w.positions[0] &&
      w.positions[0].col === 0;
    if (!startsAtCol0 || !pathMatchesMatrix(w.positions, w.symbol, evalMatrix)) {
      logger.warn("golden_tree_win_guard_drop_line", {
        winRulesVersion: WIN_RULES_VERSION,
        symbol: w.symbol,
        count: w.count,
        positions: w.positions,
        amount: w.amount,
      });
      continue;
    }
    const base = basePayout(w.symbol, w.count, betAmount);
    if (base <= 0) continue;
    // Keep calculator amount (includes wild mult) only if path still valid.
    const amount = roundMoney(w.amount);
    if (amount <= 0) continue;
    lineTotal = roundMoney(lineTotal + amount);
    lineWins.push({ ...w, amount, baseAmount: base });
  }

  const scatterWins = [];
  let scatterTotal = 0;

  let starCount = 0;
  for (const col of STAR_REELS) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (evalMatrix[col]?.[row] === SYMBOLS.STAR) starCount += 1;
    }
  }
  if (starCount >= 3) {
    const amount = roundMoney(STAR_SCATTER_PAY[3] * (betAmount / REFERENCE_BET));
    scatterTotal = roundMoney(scatterTotal + amount);
    scatterWins.push({ kind: SYMBOLS.STAR, count: starCount, amount });
  }

  let dollarCount = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (evalMatrix[col]?.[row] === SYMBOLS.DOLLAR) dollarCount += 1;
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

  if (totalWin !== roundMoney(fresh.totalWin)) {
    logger.warn("golden_tree_win_guard_total_mismatch", {
      freshTotal: fresh.totalWin,
      hardenedTotal: totalWin,
      droppedLines: fresh.lineWins.length - lineWins.length,
    });
  }

  return {
    ...fresh,
    lineWins,
    scatterWins,
    lineWinTotal: lineTotal,
    scatterWinTotal: scatterTotal,
    totalWin,
    winRulesVersion: WIN_RULES_VERSION,
  };
}

module.exports = { hardenWinResult, WIN_RULES_VERSION };
