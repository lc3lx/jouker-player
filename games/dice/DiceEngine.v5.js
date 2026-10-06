"use strict";

/**
 * King Arth (Zeus) engine v5 — profile-driven.
 *
 * Same board, symbols, published pay formulas, tumble rules and special-symbol
 * scheduling as v4, and the same RNG draw order, but every probability comes
 * from a calibrated economy profile (games/slotProfiles). Two v5-only fixes:
 * the seeded RNG is a true [0, 1), and maxWin comes from the profile rules.
 *
 * The profile id is part of the outcome so provable-fairness replay
 * (services/kingArthFairnessService.js) re-runs the exact same game.
 */

const v4 = require("./DiceEngine");
const { createSeededRng } = require("./seededRng");

const ECONOMY_VERSION = 5;
const {
  COLS, ROWS, REGULAR_SYMBOLS, MULTIPLIER, MULTIPLIER_VALUES, JACKPOT, HEAD,
  JACKPOT_MIN_SYMBOLS, FREE_SPINS_AWARD,
} = v4;
const MAX_TUMBLES = 40;

function weightedIndex(rng, weights) {
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function pickFace(rng, plaques, mode) {
  const percents = plaques[mode];
  let roll = rng() * 100;
  for (let i = 0; i < percents.length; i += 1) {
    roll -= percents[i];
    if (roll < 0) return plaques.values[i];
  }
  return null;
}

function pickSymbol(rng, params, isFreeSpin, headsAllowed) {
  const regular = isFreeSpin ? params.symbols.bonus : params.symbols.base;
  const headWeight = isFreeSpin ? params.headWeight.bonus : params.headWeight.base;
  const choice = weightedIndex(rng, [...regular, headsAllowed ? headWeight : 0]);
  return choice < REGULAR_SYMBOLS ? choice : HEAD;
}

function generateGrid(rng, params, isFreeSpin, superBonus) {
  const mode = isFreeSpin ? (superBonus ? "super" : "bonus") : "base";
  const face = pickFace(rng, params.plaques, mode);
  const jackpotRoll = rng();
  const jackpotCount = jackpotRoll < params.jackpot.win ? 3
    : jackpotRoll < params.jackpot.appearance ? (rng() < 0.5 ? 1 : 2) : 0;
  const naturalBonus = !isFreeSpin && rng() < params.naturalBonusProbability;
  const special = [];
  if (face !== null) special.push(MULTIPLIER + MULTIPLIER_VALUES.indexOf(face));
  special.push(...Array(jackpotCount).fill(JACKPOT));
  if (naturalBonus) special.push(...Array(4).fill(HEAD));
  const positions = Array.from({ length: COLS * ROWS }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const scheduled = new Map(special.map((symbol, i) => [positions[i], symbol]));
  const grid = Array.from({ length: COLS }, () => Array(ROWS));
  let heads = naturalBonus ? 4 : 0;
  for (let c = 0; c < COLS; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      const scheduledSymbol = scheduled.get(c * ROWS + r);
      if (scheduledSymbol !== undefined) grid[c][r] = scheduledSymbol;
      else {
        const symbol = pickSymbol(rng, params, isFreeSpin, isFreeSpin || heads < 3);
        if (symbol === HEAD) heads += 1;
        grid[c][r] = symbol;
      }
    }
  }
  return grid;
}

function collapseGrid(grid, removed, rng, params, isFreeSpin) {
  const next = [];
  let heads = v4.headCells(grid).length;
  for (let c = 0; c < COLS; c += 1) {
    const survivors = grid[c].filter((_, r) => !removed.has(`${c},${r}`));
    const incoming = [];
    while (incoming.length + survivors.length < ROWS) {
      // Plaques and jackpots are sampled once per spin and survive the cascade.
      const symbol = pickSymbol(rng, params, isFreeSpin, isFreeSpin || heads < 3);
      if (symbol === HEAD) heads += 1;
      incoming.push(symbol);
    }
    next[c] = [...incoming, ...survivors];
  }
  return next;
}

function runTumbles(initialGrid, rng, params, { stake, isFreeSpin, superBonus, freeSpinMultiplier }) {
  let grid = v4.cloneGrid(initialGrid);
  let baseWin = 0;
  const lineWins = [];
  const winningCells = new Set();
  const cascadeSteps = [];
  for (let index = 0; index < MAX_TUMBLES; index += 1) {
    const beforeGrid = v4.cloneGrid(grid);
    const { wins, winningCells: stepKeys } = v4.findPayAnywhereWins(grid, stake, 1);
    if (!wins.length) break;
    const stepWin = v4.roundMoney(wins.reduce((sum, w) => sum + w.win, 0));
    baseWin = v4.roundMoney(baseWin + stepWin);
    const afterGrid = collapseGrid(grid, stepKeys, rng, params, isFreeSpin);
    stepKeys.forEach((key) => winningCells.add(key));
    lineWins.push(...wins);
    const hits = v4.multiplierCells(afterGrid);
    cascadeSteps.push({
      phase: "tumble",
      index,
      grid: beforeGrid,
      afterGrid: v4.cloneGrid(afterGrid),
      win: stepWin,
      wins,
      cells: [...stepKeys].map((key) => {
        const [col, row] = key.split(",").map(Number);
        return { col, row };
      }),
      multiplierHits: hits,
      multiplierTotal: hits.reduce((sum, m) => sum + m.value, 0),
    });
    grid = afterGrid;
  }
  const collected = v4.multiplierCells(grid).reduce((sum, p) => sum + p.value, 0);
  const resolved = v4.resolvePayoutMultiplier({
    baseWin,
    plaqueSum: collected,
    carried: isFreeSpin ? Number(freeSpinMultiplier) || 0 : 0,
    isFreeSpin,
    bankCap: Infinity,
  });
  return {
    finalGrid: grid,
    baseWin,
    collected,
    applied: resolved.applied,
    nextCarried: resolved.nextCarried,
    multipliedWin: v4.roundMoney(baseWin * resolved.applied),
    lineWins,
    winningCells,
    cascadeSteps,
  };
}

/**
 * @param {number} baseBet
 * @param {object} options  { profile, rng?, serverSeed, clientSeed, nonce, isFreeSpin,
 *                            superBonus, freeSpinMultiplier, volatility }
 */
function spin(baseBet, options = {}) {
  const profile = options.profile;
  if (!profile?.params) throw new Error("ZEUS_V5_PROFILE_REQUIRED");
  const params = profile.params;
  const rng = options.rng
    || createSeededRng(options.serverSeed, options.clientSeed, options.nonce, { exclusive: true });
  const isFreeSpin = !!options.isFreeSpin;
  const superBonus = !!(isFreeSpin && options.superBonus);
  const stake = v4.roundMoney(baseBet);

  const initialGrid = generateGrid(rng, params, isFreeSpin, superBonus);
  const tumble = runTumbles(initialGrid, rng, params, {
    stake, isFreeSpin, superBonus, freeSpinMultiplier: options.freeSpinMultiplier,
  });
  const scatterCount = v4.headCells(tumble.finalGrid).length;
  const winCap = v4.roundMoney(profile.rules.maxWinX * stake);
  const totalWin = Math.min(tumble.multipliedWin, winCap);
  const jackpotSymbolCount = v4.countJackpotSymbols(tumble.finalGrid);
  return {
    economyVersion: ECONOMY_VERSION,
    profileId: profile.id,
    grid: initialGrid,
    initialGrid,
    finalGrid: tumble.finalGrid,
    stake,
    baseBet: stake,
    doubleChance: false,
    isFreeSpin,
    freeSpinPayoutMult: 1,
    volatility: v4.normalizeVolatility(options.volatility),
    nearMiss: false,
    almostBonus: !isFreeSpin && scatterCount === 3,
    capped: tumble.multipliedWin > winCap,
    maxWin: winCap,
    totalWin,
    baseWin: tumble.baseWin,
    winningCells: [...tumble.winningCells].map((key) => {
      const [col, row] = key.split(",").map(Number);
      return { col, row };
    }),
    lineWins: tumble.lineWins,
    scatterCount,
    jackpotSymbolCount,
    jackpotTriggered: jackpotSymbolCount >= JACKPOT_MIN_SYMBOLS,
    winType: v4.classifyWinType(totalWin, stake),
    cascadeSteps: tumble.cascadeSteps,
    multipliers: { collected: tumble.collected, applied: tumble.applied, freeSpinTotal: tumble.nextCarried },
    freeSpinsAwarded: !isFreeSpin && scatterCount >= 4 ? FREE_SPINS_AWARD : 0,
  };
}

module.exports = { ECONOMY_VERSION, spin, generateGrid };
