"use strict";

/**
 * Zenobia engine v3 — profile-driven.
 *
 * Same board, Caravan-Route win rule, paytable and tumble loop as v2. What
 * changes, all to make the published odds exact:
 *   • Jackpot (3 scatters) and the natural free-spins trigger (3 BONUS coins)
 *     are scheduled per spin at the profile's probabilities, like Poseidon and
 *     Zeus. Organic jackpot scatters are capped at two and organic coins at two
 *     in the base game, so neither can complete by accident; during free spins
 *     coins are organic (retrigger needs two).
 *   • Plaque faces are drawn independently from the profile table — the v2
 *     "collapse toward small faces once a big one is on the board" suppression
 *     is gone (it was never disclosed).
 *
 * Matrix layout: matrix[col][row], row 0 = top. Amounts are bet multiples.
 */

const { REEL_COUNT, ROW_COUNT, SCATTER, JACKPOT, isMultiplier, multiplierValue } = require("./constants");
const { findWins, collectMultipliers, collectScatters, collectJackpots } = require("./winCalculator");

const MAX_TUMBLES = 40;
const ORGANIC_JACKPOT_CAP = 2;
const ORGANIC_BASE_COIN_CAP = 2;
const SCHEDULED_COINS = 3;
const SCHEDULED_JACKPOTS = 3;

function modeOf(bonusMode, superBonus) {
  return bonusMode ? (superBonus ? "super" : "bonus") : "base";
}

function pickFace(rng, plaques, mode) {
  const weights = plaques[mode];
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return plaques.values[i];
  }
  const last = weights.findLastIndex((w) => w > 0);
  return plaques.values[last];
}

/**
 * One organic cell. `coinsAllowed` / `jackpotsAllowed` zero out a symbol whose
 * on-board count already reached its organic cap.
 */
function drawCell(rng, params, mode, { coinsAllowed, jackpotsAllowed }) {
  const table = params.symbols[mode];
  const coinWeight = coinsAllowed ? params.scatterWeight[mode] : 0;
  const jackpotWeight = jackpotsAllowed ? params.jackpotWeight[mode] : 0;
  let total = coinWeight + jackpotWeight;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  roll -= coinWeight;
  if (roll < 0) return SCATTER;
  roll -= jackpotWeight;
  if (roll < 0) return JACKPOT;
  for (const [symbol, w] of table) {
    roll -= w;
    if (roll < 0) return symbol === "mult" ? `x${pickFace(rng, params.plaques, mode)}` : symbol;
  }
  const [symbol] = table[table.length - 1];
  return symbol === "mult" ? `x${pickFace(rng, params.plaques, mode)}` : symbol;
}

function capsFor(counts, bonusMode) {
  return {
    coinsAllowed: bonusMode || counts.coins < ORGANIC_BASE_COIN_CAP,
    jackpotsAllowed: counts.jackpots < ORGANIC_JACKPOT_CAP,
  };
}

function countSpecials(cells) {
  let coins = 0;
  let jackpots = 0;
  for (const cell of cells) {
    if (cell === SCATTER) coins += 1;
    else if (cell === JACKPOT) jackpots += 1;
  }
  return { coins, jackpots };
}

function generateGrid(rng, params, mode) {
  const bonusMode = mode !== "base";
  const jackpotScheduled = rng() < params.jackpot.win;
  const naturalScheduled = !bonusMode && rng() < params.naturalBonusProbability;
  const special = [];
  if (jackpotScheduled) special.push(...Array(SCHEDULED_JACKPOTS).fill(JACKPOT));
  if (naturalScheduled) special.push(...Array(SCHEDULED_COINS).fill(SCATTER));

  const positions = Array.from({ length: REEL_COUNT * ROW_COUNT }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const scheduled = new Map(special.map((s, i) => [positions[i], s]));
  const counts = countSpecials(special);

  const matrix = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const column = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      const fixed = scheduled.get(col * ROW_COUNT + row);
      if (fixed !== undefined) {
        column.push(fixed);
        continue;
      }
      const cell = drawCell(rng, params, mode, capsFor(counts, bonusMode));
      if (cell === SCATTER) counts.coins += 1;
      else if (cell === JACKPOT) counts.jackpots += 1;
      column.push(cell);
    }
    matrix.push(column);
  }
  return matrix;
}

function tumble(matrix, removedPositions, rng, params, mode) {
  const bonusMode = mode !== "base";
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const survivorsByCol = [];
  const kept = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const survivors = [];
    for (let row = 0; row < ROW_COUNT; row += 1) {
      if (!removed.has(`${col}:${row}`)) survivors.push(matrix[col][row]);
    }
    survivorsByCol.push(survivors);
    kept.push(...survivors);
  }
  const counts = countSpecials(kept);
  const next = [];
  const refills = [];
  for (let col = 0; col < REEL_COUNT; col += 1) {
    const survivors = survivorsByCol[col];
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      const cell = drawCell(rng, params, mode, capsFor(counts, bonusMode));
      if (cell === SCATTER) counts.coins += 1;
      else if (cell === JACKPOT) counts.jackpots += 1;
      incoming.push(cell);
    }
    refills.push(incoming);
    next.push([...incoming, ...survivors]);
  }
  return { matrix: next, refills };
}

function plaquesInRefills(refills) {
  const out = [];
  for (let col = 0; col < refills.length; col += 1) {
    for (let row = 0; row < refills[col].length; row += 1) {
      const cell = refills[col][row];
      if (isMultiplier(cell)) out.push({ col, row, value: multiplierValue(cell) });
    }
  }
  return out;
}

function scattersInRefills(refills) {
  const out = [];
  for (let col = 0; col < refills.length; col += 1) {
    for (let row = 0; row < refills[col].length; row += 1) {
      if (refills[col][row] === SCATTER) out.push({ col, row });
    }
  }
  return out;
}

function resolveSpin({ profile, bonusMode = false, superBonus = false, rng }) {
  if (!profile?.params) throw new Error("ZENOBIA_V3_PROFILE_REQUIRED");
  if (typeof rng !== "function") throw new Error("ZENOBIA_V3_RNG_REQUIRED");
  const params = profile.params;
  const mode = modeOf(bonusMode, superBonus);

  let matrix = generateGrid(rng, params, mode);
  const initialMatrix = matrix.map((col) => [...col]);
  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(matrix);
    if (wins.length === 0) break;
    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const cleared = new Map();
    for (const win of wins) {
      for (const [col, row] of win.positions) cleared.set(`${col}:${row}`, [col, row]);
    }
    const removedPositions = [...cleared.values()];
    const result = tumble(matrix, removedPositions, rng, params, mode);
    matrix = result.matrix;
    steps.push({
      wins,
      stepWin,
      removedPositions,
      refills: result.refills,
      newMultipliers: plaquesInRefills(result.refills),
      newScatters: scattersInRefills(result.refills),
      matrixAfter: matrix.map((col) => [...col]),
    });
  }

  const multipliers = collectMultipliers(matrix);
  const scatters = collectScatters(matrix);
  const jackpots = collectJackpots(matrix);
  return {
    initialMatrix,
    finalMatrix: matrix,
    steps,
    baseWin,
    multipliers,
    multiplierSum: multipliers.reduce((sum, m) => sum + m.value, 0),
    scatters,
    scatterCount: scatters.length,
    jackpots,
    jackpotCount: jackpots.length,
  };
}

module.exports = { resolveSpin, generateGrid, tumble, MAX_TUMBLES };
