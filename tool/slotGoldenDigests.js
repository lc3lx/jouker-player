#!/usr/bin/env node
"use strict";

/**
 * Golden outcome digests for every slot engine version that can still serve a
 * pinned bonus session. Refactors must leave these byte-identical; a changed
 * digest means a legacy session would now play a different game.
 *
 *   node tool/slotGoldenDigests.js          # print current digests
 *   node tool/slotGoldenDigests.js --write  # (re)write the fixture — only when
 *                                           # an outcome change is intended
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createOperationRng } = require("../games/utils/operationRng");

const FIXTURE = path.join(__dirname, "../test/fixtures/slotGoldenDigests.json");
const SPINS = 400;

function digest(values) {
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function poseidonOutcomes(economyVersion, mode) {
  const engine = require("../games/poseidon/spinEngine");
  const out = [];
  for (let i = 0; i < SPINS; i += 1) {
    const rng = createOperationRng(`golden-poseidon-v${economyVersion}-${mode}-${i}`);
    const s = engine.resolveSpin({ rng, economyVersion, bonusMode: mode !== "base", superBonus: mode === "super" });
    out.push([s.initialMatrix, s.finalMatrix, s.steps.length, s.baseWin, s.multiplierSum, s.scatterCount]);
  }
  return out;
}

function zenobiaOutcomes(economyVersion, mode) {
  const engine = require("../games/zenobia/spinEngine");
  const out = [];
  for (let i = 0; i < SPINS; i += 1) {
    const rng = createOperationRng(`golden-zenobia-v${economyVersion}-${mode}-${i}`);
    const s = engine.resolveSpin({ rng, economyVersion, bonusMode: mode !== "base", superBonus: mode === "super" });
    out.push([s.initialMatrix, s.finalMatrix, s.steps.length, s.baseWin, s.multiplierSum, s.scatterCount, s.jackpotCount]);
  }
  return out;
}

function zeusOutcomes(economyVersion, mode) {
  const engine = require("../games/dice/DiceEngine");
  const out = [];
  for (let i = 0; i < SPINS; i += 1) {
    const s = engine.spin(10000, {
      serverSeed: `golden-zeus-v${economyVersion}-${mode}`,
      clientSeed: "golden",
      nonce: String(i),
      economyVersion,
      isFreeSpin: mode !== "base",
      superBonus: mode === "super",
      freeSpinMultiplier: mode === "base" ? 0 : 7,
    });
    out.push([s.initialGrid, s.finalGrid, s.cascadeSteps.length, s.baseWin, s.totalWin, s.multipliers, s.scatterCount, s.jackpotSymbolCount]);
  }
  return out;
}

/** Engine versions that pinned sessions can still reach today. */
const ENGINES = {
  "poseidon-v1": (mode) => poseidonOutcomes(1, mode),
  "poseidon-v2": (mode) => poseidonOutcomes(2, mode),
  "poseidon-v3": (mode) => poseidonOutcomes(3, mode),
  // Zenobia sessions tagged 1 or 2 have always played the current engine.
  "zenobia-v2": (mode) => zenobiaOutcomes(2, mode),
  "zeus-v1": (mode) => zeusOutcomes(1, mode),
  "zeus-v2": (mode) => zeusOutcomes(2, mode),
  "zeus-v3": (mode) => zeusOutcomes(3, mode),
  "zeus-v4": (mode) => zeusOutcomes(4, mode),
};

function computeDigests(names = Object.keys(ENGINES)) {
  const result = {};
  for (const name of names) {
    result[name] = {};
    for (const mode of ["base", "bonus", "super"]) result[name][mode] = digest(ENGINES[name](mode));
  }
  return result;
}

function main() {
  const digests = computeDigests();
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ spinsPerMode: SPINS, digests }, null, 2) + "\n");
    console.log(`wrote ${FIXTURE}`);
  } else {
    console.log(JSON.stringify(digests, null, 2));
  }
}

if (require.main === module) main();
module.exports = { computeDigests, ENGINES, FIXTURE, SPINS };
