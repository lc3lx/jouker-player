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
  pickForcedTreeCount,
} = require("../games/goldenTree/spinEngine");
const { calculateWins } = require("../games/goldenTree/winCalculator");
const {
  WILD_REELS,
  WILD_ROW,
  SYMBOLS,
  FREE_SPINS_PER_BONUS,
  BUY_BONUS_COST,
  TARGET_RTP,
} = require("../games/goldenTree/constants");

const BET = 10000;

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
    returned += totalWin;
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

/** One purchased bonus: opening spin forces the triple, the rest roll. */
function probeBuyBonus(rounds) {
  let returned = 0;
  const trees = {};
  const mults = {};
  let spins = 0;

  for (let i = 0; i < rounds; i += 1) {
    for (let s = 0; s < FREE_SPINS_PER_BONUS; s += 1) {
      const opening = s === 0;
      const { matrix, wildMultipliers } = generateSpin({
        bonusMode: true,
        forceTrees: opening,
        forceTreeCount: opening ? null : pickForcedTreeCount(),
      });
      const { totalWin } = calculateWins(matrix, wildMultipliers, BET, {
        bonusMode: true,
      });
      returned += totalWin;
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
  console.log(`  RTP             ${(base.rtp * 100).toFixed(2)}%`);
  console.log(`  hit rate        ${(base.hitRate * 100).toFixed(2)}%`);
  console.log(`  trees per spin  ${JSON.stringify(base.trees)}`);
  console.log(`  multiplier mix  ${JSON.stringify(base.multipliers)}\n`);

  console.log(`BUY BONUS (${rounds.toLocaleString()} rounds, cost ${BUY_BONUS_COST}x bet)`);
  console.log(`  avg return      ${buy.avgReturnX.toFixed(2)}x bet`);
  console.log(`  RTP             ${(buy.rtp * 100).toFixed(2)}%`);
  console.log(`  trees per spin  ${JSON.stringify(buy.trees)}`);
  console.log(`  multiplier mix  ${JSON.stringify(buy.multipliers)}`);
}

main();
