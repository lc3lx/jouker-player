#!/usr/bin/env node
"use strict";

/**
 * Re-fit a game's super-bonus round so the super price is a fixed multiple of
 * the standard price while the super buy still returns each rung's target RTP.
 *
 *   node tool/slotSuperRescale.js --game=poseidon --ratio=10 [--write]
 *
 * Only the super plaque tilt changes; base game and standard bonus are
 * untouched, so base RTP is unaffected. The outcome digest is recomputed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { simulate } = require("./lib/slotEconomySim");
const T = require("./lib/slotProfileTemplates");
const registry = require("../games/slotProfiles/registry");

process.env.NODE_ENV = process.env.NODE_ENV || "test";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const game = arg("game", "poseidon");
  const ratio = Number(arg("ratio", 10));
  const sessions = Number(arg("sessions", 600_000));
  const dir = path.join(__dirname, "../games/slotProfiles", game);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const profiles = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const t = T.template(game);
  const values = profiles[0].params.plaques.values;
  const presence = profiles[0].params.plaques.super.reduce((a, b) => a + b, 0) / 100;

  // Super round value every rung needs: price × target, with price = ratio × standard.
  const targetEv = profiles.reduce((s, p) => s + ratio * p.buy.standardCost * p.targetRtp, 0) / profiles.length;
  console.log(`${game}: target super EV ${targetEv.toFixed(2)}x (presence ${presence})`);

  const probe = structuredClone(profiles[0]);
  const table = (alpha) => T.perSpinPercents(T.powerLawFaces(values, alpha, t.superMinFace), presence);
  let lo = 0.05;
  let hi = 4;
  let best = arg("alpha", null) == null ? null : { alpha: Number(arg("alpha")), ev: NaN };
  for (let i = 0; i < (best ? 0 : 12); i += 1) {
    const mid = (lo + hi) / 2;
    probe.params.plaques.super = table(mid);
    const r = await simulate({ game, profile: probe, kind: "session", mode: "super", count: 60_000, seed: `super-${mid}` });
    console.log(`  α=${mid.toFixed(4)} EV=${r.evX.toFixed(2)}x`);
    if (!best || Math.abs(r.evX - targetEv) < Math.abs(best.ev - targetEv)) best = { alpha: mid, ev: r.evX };
    if (r.evX < targetEv) hi = mid;
    else lo = mid;
  }
  probe.params.plaques.super = table(best.alpha);
  const final = await simulate({ game, profile: probe, kind: "session", mode: "super", count: sessions, seed: "super-final" });
  console.log(`  final α=${best.alpha.toFixed(4)} EV=${final.evX.toFixed(2)}±${final.ci95X.toFixed(2)}x capped=${final.cappedRounds}`);

  for (let i = 0; i < profiles.length; i += 1) {
    const p = profiles[i];
    p.params.plaques.super = table(best.alpha);
    p.buy.superCost = Math.round(ratio * p.buy.standardCost * 10) / 10;
    p.buy.superEv = Number(final.evX.toFixed(4));
    p.measured.buy.superRtp = Number((final.evX / p.buy.superCost).toFixed(5));
    p.measured.buy.superEvCi95X = Number(final.ci95X.toFixed(4));
    p.measured.buy.superMedianX = final.medianX;
    p.measured.calibration.superAlpha = Number(best.alpha.toFixed(6));
    p.measured.calibration.superPriceRatio = ratio;
    p.digest = registry.digestOutcomes(p);
    registry.validateProfile(p);
    console.log(`  ${p.id}: super ${p.buy.superCost}x (standard ${p.buy.standardCost}x) → RTP ${(p.measured.buy.superRtp * 100).toFixed(2)}%`);
    if (process.argv.includes("--write")) {
      fs.writeFileSync(path.join(dir, files[i]), JSON.stringify(p, null, 2) + "\n");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
