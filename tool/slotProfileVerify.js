#!/usr/bin/env node
"use strict";

/**
 * Independent verification of shipped slot economy profiles (nightly / before
 * activating a profile). Re-simulates each profile through the production
 * engines + settlement with fresh seeds and checks:
 *   • base-game RTP within 4 standard errors of the profile target
 *   • hit rate, plaque visibility, bonus and jackpot frequencies
 *   • standard and super buy-bonus RTP within 4 standard errors
 *   • the outcome digest still matches the engine code
 *
 *   node tool/slotProfileVerify.js [--game=zeus] [--profile=zeus-rtp94]
 *        [--spins=20000000] [--sessions=1000000]
 *
 * Exit code 1 when any check fails.
 */

const { simulate, JACKPOT_EV_X } = require("./lib/slotEconomySim");
const registry = require("../games/slotProfiles/registry");

process.env.NODE_ENV = process.env.NODE_ENV || "test";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function check(label, observed, expected, se, failures) {
  const z = se > 0 ? (observed - expected) / se : 0;
  const ok = Math.abs(z) <= 4;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}: ${observed.toFixed(5)} vs ${expected.toFixed(5)} (z=${z.toFixed(2)})`);
  if (!ok) failures.push(label);
}

async function verify(profile, { spins, sessions }) {
  const failures = [];
  console.log(`\n${profile.id} (target ${(profile.targetRtp * 100).toFixed(0)}%)`);
  const digestOk = registry.digestOutcomes(profile) === profile.digest;
  console.log(`  ${digestOk ? "ok  " : "FAIL"} outcome digest`);
  if (!digestOk) failures.push("digest");

  const seed = `verify-${Date.now()}`;
  const base = await simulate({ game: profile.game, profile, kind: "base", count: spins, seed });
  check("base RTP", base.rtp, profile.targetRtp, base.ci95 / 1.96, failures);
  const binomialSe = (p) => Math.sqrt((p * (1 - p)) / base.spins);
  check("hit rate", base.hitRate, profile.measured.hitRate, binomialSe(profile.measured.hitRate), failures);
  if (profile.game !== "zenobia") {
    // One scheduled plaque per spin that never leaves the board: the design
    // presence is exact, unlike the calibration run's sampled estimate.
    const presence = profile.params.plaques.base.reduce((a, b) => a + b, 0) / 100;
    check("plaque visibility", base.plaqueVisibleRate, presence, binomialSe(presence), failures);
  }
  const pNat = profile.params.naturalBonusProbability;
  check("natural bonus rate", 1 / (base.freeSpinsOneIn || Infinity), pNat, binomialSe(pNat), failures);
  const pJp = profile.params.jackpot.win;
  check("jackpot rate", 1 / (base.jackpotOneIn || Infinity), pJp, binomialSe(pJp), failures);

  for (const [mode, cost] of [["bonus", profile.buy.standardCost], ["super", profile.buy.superCost]]) {
    const r = await simulate({ game: profile.game, profile, kind: "session", mode, count: sessions, seed });
    check(`${mode} buy RTP`, r.evX / cost, profile.targetRtp, r.ci95X / 1.96 / cost, failures);
  }
  return failures;
}

async function main() {
  registry.verifyAll();
  const spins = Number(arg("spins", 20_000_000));
  const sessions = Number(arg("sessions", 1_000_000));
  const onlyGame = arg("game", null);
  const onlyProfile = arg("profile", null);
  const targets = registry.GAMES
    .filter((g) => !onlyGame || g === onlyGame)
    .flatMap((g) => registry.listProfiles(g))
    .filter((p) => p.status === "active" && (!onlyProfile || p.id === onlyProfile));
  let failed = 0;
  for (const profile of targets) {
    const failures = await verify(profile, { spins, sessions });
    if (failures.length) failed += 1;
  }
  console.log(`\n${targets.length - failed}/${targets.length} profiles verified (jackpot EV ${JACKPOT_EV_X.toFixed(2)}x per trigger)`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
