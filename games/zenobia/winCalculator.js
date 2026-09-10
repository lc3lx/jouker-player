/**
 * Zenobia win calculator — "Caravan Route" evaluation on a 6×5 board.
 *
 * A route starts on reel 0 and steps one reel right at a time, each step
 * touching the previous cell (same row, edge, or corner — |Δrow| ≤ 1). Every
 * cell on the route carries the same symbol. Multiplier plaques and the BONUS
 * coin are route breakers: no route passes through them.
 *
 * Every geometrically distinct maximal route pays. A 3-cell prefix of a longer
 * run of the same symbol is not a separate win, so a 6-reel route never also
 * pays as a 4 and a 5.
 *
 * Matrix layout: matrix[col][row], row 0 = top. Payouts here are bet multiples.
 */

const {
  REEL_COUNT,
  ROW_COUNT,
  MIN_ROUTE,
  SCATTER,
  isRouteBreaker,
  isMultiplier,
  multiplierValue,
  payoutFor,
} = require("./constants");

/** Can [cell] continue a route whose symbol so far is [base]? */
function cellContinues(cell, base) {
  if (cell == null || isRouteBreaker(cell)) return { ok: false, base };
  if (base === null) return { ok: true, base: cell };
  if (cell === base) return { ok: true, base };
  return { ok: false, base };
}

function routeKey(symbol, positions) {
  return `${symbol}:${positions.map(([c, r]) => `${c},${r}`).join(">")}`;
}

function isPrefixRoute(shortPos, longPos) {
  if (shortPos.length >= longPos.length) return false;
  for (let i = 0; i < shortPos.length; i += 1) {
    if (shortPos[i][0] !== longPos[i][0] || shortPos[i][1] !== longPos[i][1]) {
      return false;
    }
  }
  return true;
}

/** Drop short prefixes of a longer run of the same symbol. */
function keepMaximalRoutes(found) {
  const seen = new Set();
  const unique = [];
  for (const hit of found) {
    const key = routeKey(hit.symbol, hit.positions);
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
          isPrefixRoute(a.positions, b.positions),
      ),
  );
}

/** Depth-first walk of every L→R adjacent route rooted on reel 0. */
function collectRoutes(matrix) {
  const found = [];

  function walk(col, row, base, positions) {
    if (positions.length >= MIN_ROUTE) {
      found.push({
        symbol: base,
        length: positions.length,
        positions: positions.map(([c, r]) => [c, r]),
      });
    }

    const nextCol = col + 1;
    if (nextCol >= REEL_COUNT) return;

    for (let dr = -1; dr <= 1; dr += 1) {
      const nextRow = row + dr;
      if (nextRow < 0 || nextRow >= ROW_COUNT) continue;
      const step = cellContinues(matrix[nextCol][nextRow], base);
      if (!step.ok) continue;
      positions.push([nextCol, nextRow]);
      walk(nextCol, nextRow, step.base, positions);
      positions.pop();
    }
  }

  for (let row = 0; row < ROW_COUNT; row += 1) {
    const step = cellContinues(matrix[0][row], null);
    if (!step.ok) continue;
    walk(0, row, step.base, [[0, row]]);
  }

  return found;
}

/**
 * Paying routes on the current board.
 * Returns [{ symbol, length, positions: [[col,row], …], payout }] where
 * `payout` is in bet multiples.
 */
function findWins(matrix) {
  const wins = [];
  for (const route of keepMaximalRoutes(collectRoutes(matrix))) {
    const payout = payoutFor(route.symbol, route.length);
    if (payout <= 0) continue;
    wins.push({ ...route, payout });
  }
  // Stable order: top-most start first, then by geometry — keeps the client's
  // route-by-route replay deterministic across runs.
  wins.sort((a, b) => {
    const rowA = a.positions[0][1];
    const rowB = b.positions[0][1];
    if (rowA !== rowB) return rowA - rowB;
    const keyA = routeKey(a.symbol, a.positions);
    const keyB = routeKey(b.symbol, b.positions);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return wins;
}

/** Plaques currently on the board, as [{ col, row, value }]. */
function collectMultipliers(matrix) {
  const out = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const cell = matrix[col][row];
      if (isMultiplier(cell)) {
        out.push({ col, row, value: multiplierValue(cell) });
      }
    }
  }
  return out;
}

/** BONUS coins currently on the board, as [{ col, row }]. */
function collectScatters(matrix) {
  const out = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (matrix[col][row] === SCATTER) out.push({ col, row });
    }
  }
  return out;
}

/** Jackpot scatters on the board, as [{ col, row }]. */
function collectJackpots(matrix) {
  const out = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (matrix[col][row] === "jackpot") out.push({ col, row });
    }
  }
  return out;
}

module.exports = {
  findWins,
  collectRoutes,
  keepMaximalRoutes,
  collectMultipliers,
  collectScatters,
  collectJackpots,
  cellContinues,
};
