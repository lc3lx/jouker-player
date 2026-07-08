/**
 * Scatter-pays win evaluation for the 6×5 Poseidon grid.
 * All amounts are bet multiples — poseidonService converts to coins.
 */

const {
  REEL_COUNT,
  ROW_COUNT,
  SYMBOLS,
  MIN_MATCH,
  PAYING_SYMBOLS,
  isMultiplier,
  multiplierValue,
  payoutFor,
} = require("./constants");

/**
 * Find every symbol with MIN_MATCH+ occurrences anywhere on screen.
 * Returns [{ symbol, count, payout, positions: [[col,row], …] }].
 */
function findWins(matrix) {
  const positionsBySymbol = new Map();
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const cell = matrix[col][row];
      if (cell === SYMBOLS.ORB || isMultiplier(cell)) continue;
      let list = positionsBySymbol.get(cell);
      if (!list) positionsBySymbol.set(cell, (list = []));
      list.push([col, row]);
    }
  }

  const wins = [];
  for (const symbol of PAYING_SYMBOLS) {
    const positions = positionsBySymbol.get(symbol);
    if (positions && positions.length >= MIN_MATCH) {
      wins.push({
        symbol,
        count: positions.length,
        payout: payoutFor(symbol, positions.length),
        positions,
      });
    }
  }
  return wins;
}

function countScatters(matrix) {
  let count = 0;
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (matrix[col][row] === SYMBOLS.ORB) count += 1;
    }
  }
  return count;
}

/** Multiplier plaques visible on screen: [{ col, row, value }]. */
function collectMultipliers(matrix) {
  const found = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const value = multiplierValue(matrix[col][row]);
      if (value > 0) found.push({ col, row, value });
    }
  }
  return found;
}

module.exports = {
  findWins,
  countScatters,
  collectMultipliers,
};
