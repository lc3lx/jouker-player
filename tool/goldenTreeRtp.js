#!/usr/bin/env node
"use strict";

/**
 * Golden Tree economy probe.
 *
 * Measures what a player actually gets back, separately for the paid base game
 * and for a purchased bonus round, plus the tree / multiplier distributions the
 * tier weights produce. Run it after every change to `reelStrips.js`,
 * `constants.js` PAYTABLE, or the wild multiplier weights.
 *
 *   node tool/goldenTreeRtp.js [spins] [bonusRounds]
 */

const {
  generateSpin,
} = require("../games/goldenTree/spinEngine");
const { calculateWins } = require("../games/goldenTree/winCalculator");
const {
  WILD_REELS,
  WILD_ROW,
  SYMBOLS,
  FREE_SPINS_PER_BONUS,
  BUY_BONUS_COST,
  TARGET_RTP,
  MAX_WIN_MULTIPLIER,
} = require("../games/goldenTree/constants");

const BET = 10000;

// Analytic scatter expectation: rare hits converge too slowly in small runs.
// Reel windows are independent and contain at most one jackpot. Bonus trees
// replace only the middle symbol on reels 2-4.
function scratchExpectedReturn(bonusMode) {
  const { MAIN_REEL_STRIPS, BONUS_REEL_STRIPS, JACKPOT_WINDOW_ACTIVATION_ODDS } = require('../games/goldenTree/reelStrips');
  const { windowAtStop } = require('../games/goldenTree/spinEngine');
  const { MATCH_PRIZE_TYPES } = require('../games/poseidon/jackpot/jackpotSelector');
  const strips = bonusMode ? BONUS_REEL_STRIPS : MAIN_REEL_STRIPS;
  let distribution = [1, 0, 0, 0, 0, 0];
  for (let col = 0; col < strips.length; col++) {
    let normal = 0, single = 0, surviving = 0;
    for (let stop = 0; stop < strips[col].length; stop++) {
      const window = windowAtStop(strips[col], stop);
      if (window.every(s => s === window[0])) continue;
      const count = window.filter(s => s === SYMBOLS.JACKPOT).length;
      if (count === 0) normal++;
      if (count === 1) {
        single++;
        if (!(bonusMode && WILD_REELS.has(col) && window[WILD_ROW] === SYMBOLS.JACKPOT)) surviving++;
      }
    }
    const boost = Math.max(1, Math.round((0.15 * normal) / (0.85 * single)));
    const probability = surviving * boost / (normal + single * boost) / JACKPOT_WINDOW_ACTIVATION_ODDS;
    const next = Array(6).fill(0);
    for (let i = 0; i < 6; i++) {
      next[i] += distribution[i] * (1 - probability);
      if (i < 5) next[i + 1] += distribution[i] * probability;
    }
    distribution = next;
  }
  // The shuffled board contains three of each tier, so the first triple is
  // symmetric across tiers (assuming the player completes the scratch round).
  const meanPrize = MATCH_PRIZE_TYPES.reduce((sum, p) => sum + p.amount, 0) / MATCH_PRIZE_TYPES.length;
  return distribution.slice(3).reduce((a, b) => a + b, 0) * meanPrize / BET;
}

function treeCount(matrix) {
  let trees = 0;
  for (const col of WILD_REELS) {
    if (matrix[col][WILD_ROW] === SYMBOLS.WILD) trees += 1;
  }
  return trees;
}

function percentTable(hist, total) {
  return Object.fromEntries(
    Object.entries(hist)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, v]) => [k, `${((100 * v) / total).toFixed(2)}%`]),
  );
}

/** Paid base-game spins: no bonus session, no forced trees. */
function probeBaseGame(spins) {
  let returned = 0;
  const trees = {};
  const mults = {};
  let hits = 0;

  for (let i = 0; i < spins; i += 1) {
    const { matrix, wildMultipliers } = generateSpin({ bonusMode: false });
    const { totalWin } = calculateWins(matrix, wildMultipliers, BET, {
      bonusMode: false,
    });
    returned += Math.min(totalWin, BET * MAX_WIN_MULTIPLIER);
    if (totalWin > 0) hits += 1;
    const t = treeCount(matrix);
    trees[t] = (trees[t] || 0) + 1;
    for (const m of Object.values(wildMultipliers)) {
      mults[m] = (mults[m] || 0) + 1;
    }
  }

  const multTotal = Object.values(mults).reduce((a, b) => a + b, 0) || 1;
  return {
    rtp: returned / (spins * BET),
    hitRate: hits / spins,
    trees: percentTable(trees, spins),
    multipliers: percentTable(mults, multTotal),
  };
}

/** Every purchased free spin guarantees three trees. */
function probeBuyBonus(rounds) {
  let returned = 0;
  const trees = {};
  const mults = {};
  let spins = 0;

  for (let i = 0; i < rounds; i += 1) {
    for (let s = 0; s < FREE_SPINS_PER_BONUS; s += 1) {
      const { matrix, wildMultipliers } = generateSpin({
        bonusMode: true,
      });
      const { totalWin } = calculateWins(matrix, wildMultipliers, BET, {
        bonusMode: true,
      });
      returned += Math.min(totalWin, BET * MAX_WIN_MULTIPLIER);
      spins += 1;
      const t = treeCount(matrix);
      trees[t] = (trees[t] || 0) + 1;
      for (const m of Object.values(wildMultipliers)) {
        mults[m] = (mults[m] || 0) + 1;
      }
    }
  }

  const perRound = returned / rounds / BET;
  const multTotal = Object.values(mults).reduce((a, b) => a + b, 0) || 1;
  return {
    avgReturnX: perRound,
    rtp: perRound / BUY_BONUS_COST,
    trees: percentTable(trees, spins),
    multipliers: percentTable(mults, multTotal),
  };
}

function main() {
  const spins = Number(process.argv[2]) || 400000;
  const rounds = Number(process.argv[3]) || 80000;

  const base = probeBaseGame(spins);
  const buy = probeBuyBonus(rounds);

  console.log(`Golden Tree economy probe — target RTP ${TARGET_RTP}\n`);
  console.log(`BASE GAME (${spins.toLocaleString()} paid spins)`);
  console.log(`  line RTP        ${(base.rtp * 100).toFixed(2)}%`);
  console.log(`  combined RTP    ${((base.rtp + scratchExpectedReturn(false)) * 100).toFixed(2)}% (at bet ${BET}, rare awards by expectation, line payouts capped)`);
  console.log(`  hit rate        ${(base.hitRate * 100).toFixed(2)}%`);
  console.log(`  trees per spin  ${JSON.stringify(base.trees)}`);
  console.log(`  multiplier mix  ${JSON.stringify(base.multipliers)}\n`);

  console.log(`BUY BONUS (${rounds.toLocaleString()} rounds, cost ${BUY_BONUS_COST}x bet)`);
  console.log(`  avg return      ${buy.avgReturnX.toFixed(2)}x bet`);
  console.log(`  RTP             ${(buy.rtp * 100).toFixed(2)}%`);
  console.log(`  combined RTP    ${((buy.rtp + FREE_SPINS_PER_BONUS * scratchExpectedReturn(true) / BUY_BONUS_COST) * 100).toFixed(2)}% (at bet ${BET}, line payouts capped)`);
  console.log(`  trees per spin  ${JSON.stringify(buy.trees)}`);
  console.log(`  multiplier mix  ${JSON.stringify(buy.multipliers)}`);
}

main();
