"use strict";

/**
 * Poseidon engine v4 — profile-driven.
 *
 * Same board, paytable, tumble and special-symbol scheduling as v3, and the
 * same RNG draw order, but every probability comes from a calibrated economy
 * profile (games/slotProfiles). A profile that copies the v3 constants deals
 * exactly the v3 game — test/slotProfiles.test.js locks that equivalence.
 *
 * Per spin: one multiplier plaque (absolute per-spin face probabilities, the
 * remainder means no plaque), 0–3 jackpot scatters (3 opens the jackpot round),
 * and in the base game a scheduled natural bonus (four heads). Organic heads
 * are capped at three in the base game so the trigger rate is exactly the
 * published natural-bonus probability; during free spins heads are organic.
 *
 * Matrix layout: matrix[col][row], row 0 = top. Amounts are bet multiples.
 */

const { REEL_COUNT, ROW_COUNT, SCATTER, isScatter } = require("./constants");
const { findWins, collectMultipliers, collectScatters } = require("./winCalculator");

const MAX_TUMBLES = 40;
const JACKPOT = "jackpot";

function pickFace(rng, plaques, mode) {
  const percents = plaques[mode];
  let roll = rng() * 100;
  for (let i = 0; i < percents.length; i += 1) {
    roll -= percents[i];
    if (roll < 0) return plaques.values[i];
  }
  return null;
}

function pickRegularSymbol(rng, table, headWeight) {
  let total = headWeight;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  if (headWeight > 0) {
    roll -= headWeight;
    if (roll < 0) return SCATTER;
  }
  for (const [sym, w] of table) {
    roll -= w;
    if (roll < 0) return sym;
  }
  return table[table.length - 1][0];
}

function drawContext(params, bonus) {
  return {
    table: bonus ? params.symbols.bonus : params.symbols.base,
    headWeight: bonus ? params.headWeight.bonus : params.headWeight.base,
  };
}

function generateGrid(rng, params, mode) {
  const bonus = mode !== "base";
  const face = pickFace(rng, params.plaques, mode);

  const jackpotRoll = rng();
  const jackpotCount = jackpotRoll < params.jackpot.win
    ? 3
    : jackpotRoll < params.jackpot.appearance
      ? (rng() < 0.5 ? 1 : 2)
      : 0;

  const naturalBonus = !bonus && rng() < params.naturalBonusProbability;

  const special = [];
  if (face !== null) special.push(`x${face}`);
  if (jackpotCount > 0) special.push(...Array(jackpotCount).fill(JACKPOT));
  if (naturalBonus) special.push(...Array(4).fill(SCATTER));

  const positions = Array.from({ length: REEL_COUNT * ROW_COUNT }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const scheduled = new Map(special.map((s, i) => [positions[i], s]));

  const { table, headWeight } = drawContext(params, bonus);
  const matrix = Array.from({ length: REEL_COUNT }, () => Array(ROW_COUNT));
  let heads = naturalBonus ? 4 : 0;
  for (let c = 0; c < REEL_COUNT; c += 1) {
    for (let r = 0; r < ROW_COUNT; r += 1) {
      const s = scheduled.get(c * ROW_COUNT + r);
      if (s !== undefined) {
        matrix[c][r] = s;
      } else {
        const sym = pickRegularSymbol(rng, table, bonus || heads < 3 ? headWeight : 0);
        if (sym === SCATTER) heads += 1;
        matrix[c][r] = sym;
      }
    }
  }
  return matrix;
}

function tumble(matrix, removedPositions, rng, params, bonus) {
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const { table, headWeight } = drawContext(params, bonus);
  const next = [];
  const refills = [];
  let heads = 0;
  for (let c = 0; c < REEL_COUNT; c += 1) {
    for (let r = 0; r < ROW_COUNT; r += 1) {
      if (isScatter(matrix[c][r])) heads += 1;
    }
  }
  for (let c = 0; c < REEL_COUNT; c += 1) {
    const survivors = [];
    for (let r = 0; r < ROW_COUNT; r += 1) {
      if (!removed.has(`${c}:${r}`)) survivors.push(matrix[c][r]);
    }
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      const sym = pickRegularSymbol(rng, table, bonus || heads < 3 ? headWeight : 0);
      if (isScatter(sym)) heads += 1;
      incoming.push(sym);
    }
    refills.push(incoming);
    next.push([...incoming, ...survivors]);
  }
  return { matrix: next, refills };
}

/**
 * @param {object} args
 * @param {object} args.profile   calibrated economy profile (params.*)
 * @param {boolean} [args.bonusMode]
 * @param {boolean} [args.superBonus]
 * @param {() => number} args.rng
 */
function resolveSpin({ profile, bonusMode = false, superBonus = false, rng }) {
  if (!profile?.params) throw new Error("POSEIDON_V4_PROFILE_REQUIRED");
  if (typeof rng !== "function") throw new Error("POSEIDON_V4_RNG_REQUIRED");
  const params = profile.params;
  const mode = bonusMode ? (superBonus ? "super" : "bonus") : "base";

  const matrix = generateGrid(rng, params, mode);
  const initialMatrix = matrix.map((col) => [...col]);

  let currentMatrix = matrix;
  const steps = [];
  let baseWin = 0;
  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(currentMatrix);
    if (wins.length === 0) break;
    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const removedPositions = wins.flatMap((w) => w.positions);
    const result = tumble(currentMatrix, removedPositions, rng, params, bonusMode);
    currentMatrix = result.matrix;
    steps.push({
      wins,
      stepWin,
      removedPositions,
      refills: result.refills,
      matrixAfter: currentMatrix.map((col) => [...col]),
    });
  }

  const multipliers = collectMultipliers(currentMatrix);
  const scatters = collectScatters(currentMatrix);
  let jackpotCount = 0;
  for (const col of currentMatrix) for (const cell of col) if (cell === JACKPOT) jackpotCount += 1;
  return {
    initialMatrix,
    finalMatrix: currentMatrix,
    steps,
    baseWin,
    multipliers,
    multiplierSum: multipliers.reduce((sum, m) => sum + m.value, 0),
    scatters,
    scatterCount: scatters.length,
    jackpotCount,
  };
}

module.exports = { resolveSpin, generateGrid, tumble, MAX_TUMBLES };
