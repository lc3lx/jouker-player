"use strict";

const {
  roundMoney,
  PAYLINES,
  WIN_RULES_VERSION,
  minMatchCount,
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
 * Validates against the 10 fixed paylines.
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

    // Validate lineIndex references a valid payline
    if (!Number.isInteger(w.lineIndex) || w.lineIndex < 0 || w.lineIndex >= PAYLINES.length) {
      logger.warn("golden_tree_win_guard_drop_line", {
        winRulesVersion: WIN_RULES_VERSION,
        reason: "invalid_line_index",
        lineIndex: w.lineIndex,
        symbol: w.symbol,
        amount: w.amount,
      });
      continue;
    }

    // Validate minimum match count (seven=2, others=3)
    if (!Number.isInteger(w.count) || w.count < minMatchCount(w.symbol)) continue;

    // Reject if positions don't start at col 0
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

    // Validate positions match the declared payline
    const payline = PAYLINES[w.lineIndex];
    let paylineMatch = true;
    for (let i = 0; i < w.positions.length; i += 1) {
      if (w.positions[i].row !== payline[i]) {
        paylineMatch = false;
        break;
      }
    }
    if (!paylineMatch) {
      logger.warn("golden_tree_win_guard_drop_line", {
        winRulesVersion: WIN_RULES_VERSION,
        reason: "positions_dont_match_payline",
        lineIndex: w.lineIndex,
        symbol: w.symbol,
        positions: w.positions,
        expectedPayline: payline,
      });
      continue;
    }

    const base = basePayout(w.symbol, w.count, betAmount);
    if (base <= 0) continue;
    const amount = roundMoney(w.amount);
    if (amount <= 0) continue;
    lineTotal = roundMoney(lineTotal + amount);
    lineWins.push({ ...w, amount, baseAmount: base });
  }

  const scatterWins = [];
  const scatterTotal = 0;

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
