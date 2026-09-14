/**
 * Zenobia win calculator — "Caravan Route" evaluation on a 6×5 board.
 *
 * A route runs across consecutive reels in any part of the board — it does NOT
 * have to start on reel 0. Each step moves one reel right and touches the
 * previous cell (same row, edge, or corner — |Δrow| ≤ 1), and every cell on the
 * route carries the same symbol. Multiplier plaques and the BONUS coin are
 * route breakers: no route passes through them.
 *
 * Only *maximal* routes pay. A route is maximal when neither end can be
 * extended by an adjacent cell of the same symbol, which is enforced at the
 * source: the walk is seeded only on cells with no same-symbol neighbour to
 * their left, and a path is banked only when it has no same-symbol neighbour to
 * its right. So a 6-reel run never also pays as the 3, 4 and 5 inside it, and a
 * mid-board run is never double-counted against a longer run containing it.
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

function isSubRoute(shortPos, longPos) {
  if (shortPos.length >= longPos.length) return false;
  const offset = longPos.findIndex(
    ([c, r]) => c === shortPos[0][0] && r === shortPos[0][1],
  );
  if (offset < 0 || offset + shortPos.length > longPos.length) return false;
  for (let i = 0; i < shortPos.length; i += 1) {
    const [c, r] = longPos[offset + i];
    if (shortPos[i][0] !== c || shortPos[i][1] !== r) return false;
  }
  return true;
}

/**
 * Drop any route contained inside a longer one of the same symbol.
 *
 * [collectRoutes] already emits only maximal routes, so this is a safety net
 * for hand-built route lists (and for tests) rather than a hot-path filter.
 */
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
          isSubRoute(a.positions, b.positions),
      ),
  );
}

/** Is there a same-symbol cell one reel over from [col],[row] in direction [dir]? */
function hasNeighbour(matrix, col, row, symbol, dir) {
  const side = col + dir;
  if (side < 0 || side >= REEL_COUNT) return false;
  for (let dr = -1; dr <= 1; dr += 1) {
    const r = row + dr;
    if (r < 0 || r >= ROW_COUNT) continue;
    if (matrix[side][r] === symbol) return true;
  }
  return false;
}

/**
 * Depth-first walk of every maximal L→R adjacent route, anchored anywhere on
 * the board. Seeds are cells with nothing to extend into on their left; a path
 * is banked only where nothing extends it on the right.
 */
function collectRoutes(matrix) {
  const found = [];

  function walk(col, row, base, positions) {
    const extendable = hasNeighbour(matrix, col, row, base, 1);
    if (!extendable && positions.length >= MIN_ROUTE) {
      found.push({
        symbol: base,
        length: positions.length,
        positions: positions.map(([c, r]) => [c, r]),
      });
    }
    if (!extendable) return;

    for (let dr = -1; dr <= 1; dr += 1) {
      const nextRow = row + dr;
      if (nextRow < 0 || nextRow >= ROW_COUNT) continue;
      const step = cellContinues(matrix[col + 1][nextRow], base);
      if (!step.ok) continue;
      positions.push([col + 1, nextRow]);
      walk(col + 1, nextRow, step.base, positions);
      positions.pop();
    }
  }

  // A route needs MIN_ROUTE reels, so seeding past that point can never pay.
  const lastSeedCol = REEL_COUNT - MIN_ROUTE;
  for (let col = 0; col <= lastSeedCol; col += 1) {
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const step = cellContinues(matrix[col][row], null);
      if (!step.ok) continue;
      if (hasNeighbour(matrix, col, row, step.base, -1)) continue;
      walk(col, row, step.base, [[col, row]]);
    }
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
  // collectRoutes emits maximal routes only — every path it yields starts at a
  // left anchor and ends at a right anchor, so none can contain another and the
  // quadratic keepMaximalRoutes filter is not needed on the hot path.
  for (const route of collectRoutes(matrix)) {
    const payout = payoutFor(route.symbol, route.length);
    if (payout <= 0) continue;
    wins.push({ ...route, payout });
  }
  // Stable order: left-most start first, then top-most, then by geometry —
  // keeps the client's route-by-route replay deterministic and reading L→R.
  wins.sort((a, b) => {
    const colA = a.positions[0][0];
    const colB = b.positions[0][0];
    if (colA !== colB) return colA - colB;
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
