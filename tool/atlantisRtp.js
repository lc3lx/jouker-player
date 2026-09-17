#!/usr/bin/env node
"use strict";

/**
 * Economy probe for the two tumble slots that share the Poseidon rule set:
 * Poseidon (REST module) and King Arth / Zeus (socket DiceEngine).
 *
 * Reports base-game RTP including the free spins a base spin triggers, the
 * bought-bonus RTP against its price, and how often a multiplier plaque is on
 * screen — the number to watch when tuning how visible plaques are.
 *
 *   node tool/atlantisRtp.js [spins] [bonusRounds]
 */

const poseidonEngine = require("../games/poseidon/spinEngine");
const P = require("../games/poseidon/constants");
const dice = require("../games/dice/DiceEngine");
const diceSource = require("fs").readFileSync(
  require("path").join(__dirname, "../games/dice/DiceEngine.js"),
  "utf8",
);
const DICE_MIN_MATCH = Number(/const MIN_MATCH = (\d+)/.exec(diceSource)[1]);

const BET = 10000;

function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

// ── Poseidon ────────────────────────────────────────────────────────────────

function poseidonWin(spin, isBonus) {
  const applied =
    spin.baseWin > 0 && spin.multiplierSum > 0
      ? P.appliedMultiplierFor(spin.multiplierSum, isBonus)
      : 1;
  return Math.min(spin.baseWin * applied, P.MAX_WIN_MULTIPLIER);
}

function poseidonBonusRound({ bought = false, superBonus = false } = {}) {
  let remaining = bought ? P.FREE_SPINS_BOUGHT : P.FREE_SPINS_NATURAL;
  let won = 0;
  for (let guard = 0; remaining > 0 && guard < 400; guard += 1) {
    remaining -= 1;
    const s = poseidonEngine.resolveSpin({ bonusMode: true, superBonus });
    won += poseidonWin(s, true);
    if (s.multipliers.length >= P.TRIGGER_RETRIGGER_MIN) {
      remaining += P.RETRIGGER_AWARD;
    }
  }
  return won;
}

function probePoseidon(spins, bonusRounds) {
  let won = 0;
  let plaqueSpins = 0;
  let hits = 0;
  let triggers = 0;

  for (let i = 0; i < spins; i += 1) {
    const s = poseidonEngine.resolveSpin({ bonusMode: false });
    let win = poseidonWin(s, false);
    if (s.multipliers.length) plaqueSpins += 1;
    if (s.multipliers.length >= P.TRIGGER_NATURAL_MIN) {
      triggers += 1;
      win += poseidonBonusRound();
    }
    if (win > 0) hits += 1;
    won += win;
  }

  let boughtWon = 0;
  let superWon = 0;
  for (let i = 0; i < bonusRounds; i += 1) {
    boughtWon += poseidonBonusRound({ bought: true });
    superWon += poseidonBonusRound({ bought: true, superBonus: true });
  }

  return {
    rtp: won / spins,
    hitRate: hits / spins,
    plaqueRate: plaqueSpins / spins,
    triggerRate: triggers / spins,
    buyReturnX: boughtWon / bonusRounds,
    buyRtp: boughtWon / bonusRounds / P.BUY_BONUS_COST,
    buyCost: P.BUY_BONUS_COST,
    superReturnX: superWon / bonusRounds,
    superRtp: superWon / bonusRounds / P.SUPER_BUY_BONUS_COST,
    superCost: P.SUPER_BUY_BONUS_COST,
  };
}

// ── King Arth / Zeus ────────────────────────────────────────────────────────

let nonce = 0;
function dieSpin(opts = {}) {
  nonce += 1;
  return dice.spin(BET, {
    serverSeed: `probe-${nonce}`,
    clientSeed: "probe",
    nonce,
    ...opts,
  });
}

function kingArthBonusRound(spins, superBonus = false) {
  let remaining = spins;
  let won = 0;
  let carried = 0;
  for (let guard = 0; remaining > 0 && guard < 400; guard += 1) {
    remaining -= 1;
    const s = dieSpin({
      isFreeSpin: true,
      superBonus,
      freeSpinMultiplier: carried,
    });
    won += s.totalWin;
    carried = s.multipliers.freeSpinTotal;
    if (s.scatterCount >= dice.RETRIGGER_MIN_SCATTER) {
      remaining += dice.RETRIGGER_AWARD;
    }
  }
  return won;
}

function probeKingArth(spins, bonusRounds) {
  let won = 0;
  let plaqueSpins = 0;
  let hits = 0;
  let triggers = 0;

  for (let i = 0; i < spins; i += 1) {
    const s = dieSpin();
    let win = s.totalWin;
    if (s.scatterCount) plaqueSpins += 1;
    if (s.freeSpinsAwarded) {
      triggers += 1;
      win += kingArthBonusRound(s.freeSpinsAwarded);
    }
    if (win > 0) hits += 1;
    won += win;
  }

  let boughtWon = 0;
  let superWon = 0;
  for (let i = 0; i < bonusRounds; i += 1) {
    boughtWon += kingArthBonusRound(dice.FREE_SPINS_BOUGHT);
    superWon += kingArthBonusRound(dice.FREE_SPINS_BOUGHT, true);
  }

  return {
    rtp: won / spins / BET,
    hitRate: hits / spins,
    plaqueRate: plaqueSpins / spins,
    triggerRate: triggers / spins,
    buyReturnX: boughtWon / bonusRounds / BET,
    buyRtp: boughtWon / bonusRounds / BET / dice.BUY_COST_MULT,
    buyCost: dice.BUY_COST_MULT,
    superReturnX: superWon / bonusRounds / BET,
    superRtp: superWon / bonusRounds / BET / dice.SUPER_BUY_COST_MULT,
    superCost: dice.SUPER_BUY_COST_MULT,
  };
}

function report(name, r, minMatch) {
  console.log(`${name}  (min match ${minMatch})`);
  console.log(`  base RTP           ${pct(r.rtp)}`);
  console.log(`  hit rate           ${pct(r.hitRate)}`);
  console.log(`  spins with plaque  ${pct(r.plaqueRate)}`);
  console.log(`  free-spin trigger  ${pct(r.triggerRate)}`);
  console.log(
    `  buy bonus          ${r.buyReturnX.toFixed(1)}x for ${r.buyCost}x  →  ${pct(r.buyRtp)}`,
  );
  console.log(
    `  super buy          ${r.superReturnX.toFixed(1)}x for ${r.superCost}x  →  ${pct(r.superRtp)}`,
  );
  console.log("");
}

function main() {
  const spins = Number(process.argv[2]) || 60000;
  const rounds = Number(process.argv[3]) || 20000;

  report("POSEIDON ", probePoseidon(spins, rounds), P.MIN_MATCH);
  report("KING ARTH", probeKingArth(spins, rounds), DICE_MIN_MATCH);
}

main();
