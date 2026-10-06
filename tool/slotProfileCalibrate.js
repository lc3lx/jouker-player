#!/usr/bin/env node
"use strict";

/**
 * Calibrate a ladder of economy profiles for one slot game.
 *
 *   node tool/slotProfileCalibrate.js --game=poseidon [--write]
 *        [--rungs=0.90,0.92,0.94,0.96] [--hit=0.31] [--bonus-ev=55] [--super-ev=250]
 *        [--base-spins=4000000] [--sessions=600000]
 *
 * Every number comes from the production engines + settlement (see
 * tool/lib/slotEconomySim.js). Steps:
 *   1. Letter concentration k → base hit rate (paytable untouched).
 *   2. Bonus / super plaque tilt → target bonus-round EVs (fixed for all rungs).
 *   3. Precise EVs for natural, bought and super rounds.
 *   4. One large base run → the decomposition A, g[v] (one-plaque games) or
 *      A, E[W·N] (Zenobia's Bonus Box).
 *   5. Per rung, solve the base plaque tilt α so that
 *        RTP = spin part(α) + p_nat·EV_nat + p_jp·EV_jp = target
 *      exactly in expectation; price each buy at EV / target.
 *   6. Verify each rung with an independent Monte-Carlo run, store the digest.
 *
 * Only the base plaque tilt differs between rungs, so hit rate, plaque
 * visibility, bonus frequency and bonus-round feel are identical on every rung.
 */

const fs = require("node:fs");
const path = require("node:path");
const { simulate, JACKPOT_EV_X } = require("./lib/slotEconomySim");
const T = require("./lib/slotProfileTemplates");

process.env.NODE_ENV = process.env.NODE_ENV || "test";

/**
 * Per-game shape. Presence = share of spins that show a plaque (one-plaque
 * games). Bonus presence is high with moderate faces rather than rare huge
 * faces, so a bought round returns something sensible most of the time
 * instead of living off one x1000. Poseidon's super shows a x20+ plaque on
 * every spin (presence 1), as its rules screen promises. Zeus retriggers about
 * once per round, so it needs lower presence for the same round EV.
 */
const GAME_DEFAULTS = {
  poseidon: { hit: 0.31, basePresence: 0.30, bonusPresence: 0.9, superPresence: 1.0, bonusEv: 55, superEv: 250 },
  zeus: { hit: 0.31, basePresence: 0.30, bonusPresence: 0.45, superPresence: 0.4, bonusEv: 55, superEv: 250 },
  // Zenobia plaques land per cell: presence is the "mult" weight of each table.
  zenobia: { hit: null, baseMult: 2.5, bonusMult: 8, superMult: 4.5, bonusEv: 55, superEv: 250 },
};

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

async function bisect(lo, hi, f, target, { iterations = 12, increasing = true } = {}) {
  let best = null;
  for (let i = 0; i < iterations; i += 1) {
    const mid = (lo + hi) / 2;
    const value = await f(mid);
    if (!best || Math.abs(value - target) < Math.abs(best.value - target)) best = { x: mid, value };
    if ((value < target) === increasing) lo = mid;
    else hi = mid;
  }
  return best;
}

/** Plaque table for a mode at tilt α (and presence for one-plaque games). */
function plaqueTable(game, values, alpha, { presence = 1, minFace = 0 } = {}) {
  const q = T.powerLawFaces(values, alpha, minFace);
  return game === "zenobia" ? q.map((w) => Number(w.toFixed(12))) : T.perSpinPercents(q, presence);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

async function main() {
  const game = arg("game", null);
  if (!GAME_DEFAULTS[game]) throw new Error("--game=poseidon|zeus|zenobia required");
  const d = GAME_DEFAULTS[game];
  const rungs = arg("rungs", "0.90,0.92,0.94,0.96").split(",").map(Number);
  const hitTarget = arg("hit", d.hit) == null ? null : Number(arg("hit", d.hit));
  const bonusEvTarget = Number(arg("bonus-ev", d.bonusEv));
  const superEvTarget = Number(arg("super-ev", d.superEv));
  const baseSpins = Number(arg("base-spins", 4_000_000));
  const sessions = Number(arg("sessions", 600_000));
  const write = process.argv.includes("--write");

  const t = T.template(game);
  const values = t.params.plaques.values;
  const profile = structuredClone({ ...t, id: `${game}-calibrating`, status: "active", targetRtp: 0.94 });
  delete profile.letters;
  delete profile.superMinFace;
  const setBase = (alpha) => {
    profile.params.plaques.base = plaqueTable(game, values, alpha, { presence: d.basePresence });
  };
  if (game === "zenobia") {
    const setMult = (mode, w) => {
      profile.params.symbols[mode] = profile.params.symbols[mode].map(([s, x]) => [s, s === "mult" ? w : x]);
    };
    setMult("base", d.baseMult);
    setMult("bonus", d.bonusMult);
    setMult("super", d.superMult);
  }
  setBase(2);
  profile.params.plaques.bonus = plaqueTable(game, values, 2, { presence: d.bonusPresence });
  profile.params.plaques.super = plaqueTable(game, values, 2, { presence: d.superPresence, minFace: t.superMinFace });

  // 1. hit rate via letter concentration (from the profile's table, so the
  //    per-game plaque weight set above survives).
  const baseSymbols = structuredClone(profile.params.symbols.base);
  let k = 1;
  if (hitTarget != null) {
    const best = await bisect(0.8, 2.6, async (x) => {
      profile.params.symbols.base = T.scaleLetters(game, baseSymbols, t.letters, x);
      const r = await simulate({ game, profile, kind: "base", count: 200_000, seed: `hit-${x}` });
      log(`k=${x.toFixed(4)} hit=${(r.hitRate * 100).toFixed(2)}%`);
      return r.hitRate;
    }, hitTarget, { iterations: 10 });
    k = Number(best.x.toFixed(4));
  }
  profile.params.symbols.base = T.scaleLetters(game, baseSymbols, t.letters, k);
  log(`letter concentration k=${k}`);

  // 2. bonus / super tilt for the target round EVs (EV falls as α rises)
  const sessionEv = async (mode, count, seed) => (await simulate({ game, profile, kind: "session", mode, count, seed })).evX;
  const bonus = await bisect(0.6, 4, async (a) => {
    profile.params.plaques.bonus = plaqueTable(game, values, a, { presence: d.bonusPresence });
    const ev = await sessionEv("bonus", 60_000, `bonus-${a}`);
    log(`bonus α=${a.toFixed(4)} EV=${ev.toFixed(2)}x`);
    return ev;
  }, bonusEvTarget, { iterations: 11, increasing: false });
  profile.params.plaques.bonus = plaqueTable(game, values, bonus.x, { presence: d.bonusPresence });
  const superFit = await bisect(0.2, 4, async (a) => {
    profile.params.plaques.super = plaqueTable(game, values, a, { presence: d.superPresence, minFace: t.superMinFace });
    const ev = await sessionEv("super", 60_000, `super-${a}`);
    log(`super α=${a.toFixed(4)} EV=${ev.toFixed(2)}x`);
    return ev;
  }, superEvTarget, { iterations: 11, increasing: false });
  profile.params.plaques.super = plaqueTable(game, values, superFit.x, { presence: d.superPresence, minFace: t.superMinFace });

  // 3. precise round EVs
  log("measuring round EVs…");
  const natural = await simulate({ game, profile, kind: "session", mode: "natural", count: sessions, seed: "ev-natural" });
  const bought = await simulate({ game, profile, kind: "session", mode: "bonus", count: sessions, seed: "ev-bonus" });
  const superRound = await simulate({ game, profile, kind: "session", mode: "super", count: sessions, seed: "ev-super" });
  log(`EV natural=${natural.evX.toFixed(2)} bonus=${bought.evX.toFixed(2)}±${bought.ci95X.toFixed(2)} super=${superRound.evX.toFixed(2)}±${superRound.ci95X.toFixed(2)}`);

  // 4. base decomposition
  log(`base decomposition over ${baseSpins} spins…`);
  const base = await simulate({ game, profile, kind: "base", count: baseSpins, seed: "decomposition" });
  const { A, g, wn } = base.decomposition;
  const pNat = profile.params.naturalBonusProbability;
  const pJp = profile.params.jackpot.win;
  const fixed = pNat * natural.evX + pJp * JACKPOT_EV_X;
  const spinPart = (alpha) => {
    const q = T.powerLawFaces(values, alpha);
    if (game === "zenobia") return A + wn * T.meanFace(values, q);
    // g[v] was measured at presence d.basePresence; the face table keeps it.
    return A + q.reduce((sum, w, i) => sum + w * g[i], 0);
  };
  log(`A=${A.toFixed(4)} fixed(fs+jackpot)=${fixed.toFixed(4)} hit=${(base.hitRate * 100).toFixed(2)}%`);

  // 5 + 6. one profile per rung
  const outDir = path.join(__dirname, "../games/slotProfiles", game);
  const written = [];
  for (const target of rungs) {
    const needed = target - fixed;
    const lowest = spinPart(12);
    const highest = spinPart(0.05);
    if (needed < lowest || needed > highest) {
      throw new Error(`${game} ${target}: spin part ${needed.toFixed(4)} outside reachable [${lowest.toFixed(4)}, ${highest.toFixed(4)}] — change presence or concentration`);
    }
    let lo = 0.05;
    let hi = 12;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (spinPart(mid) > needed) lo = mid;
      else hi = mid;
    }
    const alpha = (lo + hi) / 2;
    const rung = structuredClone(profile);
    rung.id = `${game}-rtp${Math.round(target * 100)}`;
    rung.label = `${(target * 100).toFixed(0)}%`;
    rung.targetRtp = target;
    rung.volatility = "low";
    rung.params.plaques.base = plaqueTable(game, values, alpha, { presence: d.basePresence });
    const standardCost = round1(bought.evX / target);
    const superCost = round1(superRound.evX / target);
    rung.buy = {
      standardCost,
      superCost,
      standardEv: Number(bought.evX.toFixed(4)),
      superEv: Number(superRound.evX.toFixed(4)),
    };

    log(`${rung.id}: α=${alpha.toFixed(4)} mean face=${T.meanFace(values, T.powerLawFaces(values, alpha)).toFixed(3)} — verifying…`);
    const check = await simulate({ game, profile: rung, kind: "base", count: Math.min(baseSpins, 3_000_000), seed: `verify-${rung.id}` });
    rung.measured = {
      rtp: Number((spinPart(alpha) + fixed).toFixed(5)),
      rtpMonteCarlo: Number(check.rtp.toFixed(5)),
      rtpMonteCarloCi95: Number(check.ci95.toFixed(5)),
      sdPerSpin: Number(check.sdPerSpin.toFixed(4)),
      hitRate: Number(base.hitRate.toFixed(5)),
      winAtLeastBetRate: Number(check.winAtLeastBetRate.toFixed(5)),
      plaqueVisibleRate: Number(check.plaqueVisibleRate.toFixed(5)),
      plaqueAppliedRate: Number(check.plaqueAppliedRate.toFixed(5)),
      freeSpinsOneIn: Math.round(1 / pNat),
      jackpotOneIn: Math.round(1 / pJp),
      parts: {
        spins: Number(spinPart(alpha).toFixed(5)),
        freeSpins: Number((pNat * (natural.evX - natural.jackpotEvX)).toFixed(5)),
        jackpot: Number((pJp * JACKPOT_EV_X + pNat * natural.jackpotEvX).toFixed(5)),
      },
      naturalRoundEvX: Number(natural.evX.toFixed(4)),
      buy: {
        standardRtp: Number((bought.evX / standardCost).toFixed(5)),
        standardEvCi95X: Number(bought.ci95X.toFixed(4)),
        superRtp: Number((superRound.evX / superCost).toFixed(5)),
        superEvCi95X: Number(superRound.ci95X.toFixed(4)),
        standardMedianX: bought.medianX,
        superMedianX: superRound.medianX,
        avgSpins: Number(bought.avgSpins.toFixed(3)),
        retriggersPerRound: Number(bought.retriggersPerRound.toFixed(4)),
      },
      maxWinX: rung.rules.maxWinX,
      calibration: { letterConcentration: k, baseAlpha: Number(alpha.toFixed(6)), bonusAlpha: Number(bonus.x.toFixed(6)), superAlpha: Number(superFit.x.toFixed(6)) },
      sims: { baseSpins, sessions, verifySpins: check.spins },
      generatedAt: new Date().toISOString(),
    };
    rung.digest = require("../games/slotProfiles/registry").digestOutcomes(rung);
    require("../games/slotProfiles/registry").validateProfile(rung);
    log(`${rung.id}: expected ${(rung.measured.rtp * 100).toFixed(2)}% MC ${(check.rtp * 100).toFixed(2)}±${(check.ci95 * 100).toFixed(2)}% buy ${standardCost}x/${superCost}x`);
    if (write) {
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `${rung.id}.json`);
      fs.writeFileSync(file, JSON.stringify(rung, null, 2) + "\n");
      written.push(file);
    }
  }
  if (write) log("wrote", written.join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
