const economy = require("../utils/slotEconomy");
/**
 * Poseidon spin engine — generates the drop and resolves the entire tumbling
 * sequence server-side. The client only replays the presentation.
 *
 * Economy v3: Zeus-cloned calibrated economy:
 * - Controlled per-spin multiplier distribution (rare 50+ multipliers).
 * - Calibrated jackpot (18% teaser appearance, 0.0001 win trigger).
 * - Controlled natural bonus trigger (0.004 = 0.4% = 1 in 250 spins).
 *
 * Matrix layout: matrix[col][row], row 0 = top. All win amounts here are bet
 * multiples; poseidonService converts them to coins.
 */

const crypto = require("crypto");
const {
  ECONOMY_VERSION,
  REEL_COUNT,
  ROW_COUNT,
  MIN_MATCH,
  BASE_WEIGHTS,
  BONUS_WEIGHTS,
  PLAQUE_WIN_KEEP,
  BONUS_CLUSTER_SCALE,
  PAYING_SYMBOLS,
  MULTIPLIER_VALUES,
  BASE_MULTIPLIER_WEIGHTS,
  BONUS_MULTIPLIER_WEIGHTS,
  SUPER_MULTIPLIER_WEIGHTS,
  SUPPRESSED_MULTIPLIER_WEIGHTS,
  BIG_MULTIPLIER_THRESHOLD,
  SUPER_MULTIPLIER_MIN,
  JACKPOT_APPEARANCE_PROBABILITY,
  JACKPOT_WIN_PROBABILITY,
  NATURAL_BONUS_PROBABILITY,
  JACKPOT_MIN_SYMBOLS,
  SCATTER,
  HEAD_WEIGHT_BASE,
  HEAD_WEIGHT_BONUS,
  SYMBOLS,
  isMultiplier,
  isScatter,
  multiplierValue,
} = require("./constants");
const { findWins, collectMultipliers, collectScatters } = require("./winCalculator");

/** Hard stop — a legit sequence exhausts long before this. */
const MAX_TUMBLES = 40;

function secureRandom() {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function secureRandomInt(maxExclusive) {
  return crypto.randomInt(0, maxExclusive);
}

const REGULAR_BASE_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 11],
  [SYMBOLS.N, 11],
  [SYMBOLS.E, 11],
  [SYMBOLS.A, 11],
  [SYMBOLS.STARFISH, 9],
  [SYMBOLS.CORAL, 9],
  [SYMBOLS.FISH, 7.5],
  [SYMBOLS.CROWN, 5.5],
  [SYMBOLS.PEARL, 5],
]);

const REGULAR_BONUS_WEIGHTS = Object.freeze([
  [SYMBOLS.S, 13],
  [SYMBOLS.N, 13],
  [SYMBOLS.E, 13],
  [SYMBOLS.A, 13],
  [SYMBOLS.STARFISH, 8],
  [SYMBOLS.CORAL, 8],
  [SYMBOLS.FISH, 6],
  [SYMBOLS.CROWN, 4.5],
  [SYMBOLS.PEARL, 4],
]);

function pickMultiplierValue(rng, opts = {}) {
  const weights = opts.superBonus
    ? SUPER_MULTIPLIER_WEIGHTS
    : opts.bonus
      ? BONUS_MULTIPLIER_WEIGHTS
      : BASE_MULTIPLIER_WEIGHTS;
  let roll = rng() * 100;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return MULTIPLIER_VALUES[i];
  }
  return null;
}

function pickRegularSymbol(rng, isFreeSpin, headsAllowed = true) {
  const table = isFreeSpin ? REGULAR_BONUS_WEIGHTS : REGULAR_BASE_WEIGHTS;
  const headWeight = headsAllowed ? (isFreeSpin ? HEAD_WEIGHT_BONUS : HEAD_WEIGHT_BASE) : 0;
  let total = headWeight;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  if (headsAllowed) {
    roll -= headWeight;
    if (roll < 0) return SCATTER;
  }
  for (const [sym, w] of table) {
    roll -= w;
    if (roll < 0) return sym;
  }
  return table[table.length - 1][0];
}

function countBigMultipliers(matrix) {
  let n = 0;
  for (const col of matrix) {
    for (const cell of col) {
      if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) n += 1;
    }
  }
  return n;
}

function countBigInCells(cells) {
  let n = 0;
  for (const cell of cells) {
    if (multiplierValue(cell) >= BIG_MULTIPLIER_THRESHOLD) n += 1;
  }
  return n;
}

function matrixHasMultiplier(matrix) {
  for (const col of matrix) {
    for (const cell of col) {
      if (isMultiplier(cell)) return true;
    }
  }
  return false;
}

function generateGrid(rng, { bonus = false, superBonus = false } = {}) {
  const face = pickMultiplierValue(rng, { bonus, superBonus });
  const jackpotRoll = rng();
  const jackpotCount = jackpotRoll < JACKPOT_WIN_PROBABILITY ? 3
    : jackpotRoll < JACKPOT_APPEARANCE_PROBABILITY ? (rng() < 0.5 ? 1 : 2) : 0;
  const naturalBonus = !bonus && rng() < NATURAL_BONUS_PROBABILITY;

  const special = [];
  if (face !== null) special.push(`x${face}`);
  special.push(...Array(jackpotCount).fill("jackpot"));
  if (naturalBonus) special.push(...Array(4).fill(SCATTER));

  const positions = Array.from({ length: REEL_COUNT * ROW_COUNT }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const scheduled = new Map(special.map((s, i) => [positions[i], s]));

  const matrix = Array.from({ length: REEL_COUNT }, () => Array(ROW_COUNT));
  let heads = naturalBonus ? 4 : 0;
  for (let c = 0; c < REEL_COUNT; c++) {
    for (let r = 0; r < ROW_COUNT; r++) {
      const s = scheduled.get(c * ROW_COUNT + r);
      if (s !== undefined) {
        matrix[c][r] = s;
      } else {
        const sym = pickRegularSymbol(rng, bonus, bonus || heads < 3);
        if (sym === SCATTER) heads++;
        matrix[c][r] = sym;
      }
    }
  }
  return matrix;
}

function tumble(matrix, removedPositions, rng, { bonus = false } = {}) {
  const removed = new Set(removedPositions.map(([c, r]) => `${c}:${r}`));
  const next = [];
  const refills = [];
  let heads = 0;
  for (let c = 0; c < REEL_COUNT; c++) {
    for (let r = 0; r < ROW_COUNT; r++) {
      if (matrix[c][r] === SCATTER) heads++;
    }
  }
  for (let c = 0; c < REEL_COUNT; c++) {
    const survivors = [];
    for (let r = 0; r < ROW_COUNT; r++) {
      if (!removed.has(`${c}:${r}`)) survivors.push(matrix[c][r]);
    }
    const incoming = [];
    while (survivors.length + incoming.length < ROW_COUNT) {
      const sym = pickRegularSymbol(rng, bonus, bonus || heads < 3);
      if (sym === SCATTER) heads++;
      incoming.push(sym);
    }
    refills.push(incoming);
    next.push([...incoming, ...survivors]);
  }
  return { matrix: next, refills };
}

/**
 * Resolve one full spin.
 *
 * Returns bet-multiple amounts:
 * {
 *   initialMatrix, finalMatrix,
 *   steps: [{ wins, stepWin, removedPositions, refills, matrixAfter }],
 *   baseWin,          // sum of tumble step wins, before any multiplier
 *   multipliers,      // plaques on the final screen [{col,row,value}]
 *   multiplierSum,
 *   scatters,
 *   scatterCount,
 * }
 */
function resolveSpin({
  bonusMode = false,
  superBonus = false,
  rng = secureRandom,
  edgeParams = null,
  economyVersion = ECONOMY_VERSION,
  payScale = null,
} = {}) {
  if (economyVersion === 1) return require("./spinEngine.v1").resolveSpin({ bonusMode, superBonus, rng, edgeParams });
  if (economyVersion === 2) return require("./spinEngine.v2").resolveSpin({ bonusMode, superBonus, rng, edgeParams });

  const scale = payScale ?? (bonusMode ? (superBonus ? 0.62 : 0.62) : 1);
  const matrix = generateGrid(rng, { bonus: bonusMode, superBonus: !!superBonus && bonusMode });
  const initialMatrix = matrix.map((col) => [...col]);

  let currentMatrix = matrix;
  const steps = [];
  let baseWin = 0;

  for (let i = 0; i < MAX_TUMBLES; i += 1) {
    const wins = findWins(currentMatrix).map(w => ({ ...w, payout: w.payout * scale }));
    if (wins.length === 0) break;

    const stepWin = wins.reduce((sum, w) => sum + w.payout, 0);
    baseWin += stepWin;
    const removedPositions = wins.flatMap((w) => w.positions);
    const result = tumble(currentMatrix, removedPositions, rng, { bonus: bonusMode });
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
  return {
    initialMatrix,
    finalMatrix: currentMatrix,
    steps,
    baseWin,
    multipliers,
    multiplierSum: multipliers.reduce((sum, m) => sum + m.value, 0),
    scatters,
    scatterCount: scatters.length,
  };
}

module.exports = {
  resolveSpin,
  generateGrid,
  tumble,
  pickMultiplierValue,
  secureRandom,
  secureRandomInt,
  countBigMultipliers,
  countBigInCells,
};
