"use strict";

// Uses the production engines and bank resolver; never truncates a bonus session.
const fs = require("node:fs");
const path = require("node:path");
const economy = require("../games/utils/slotEconomy");
const edge = require("../games/utils/houseEdgeController");
const calibrationPath = path.join(__dirname, "../games/utils/slotEconomyCalibration.json");

function rngFor(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function adapter(game, version = 2) {
  const suffix = version === 1 ? ".v1" : "";
  if (game === "zeus") {
    const e = require(`../games/dice/DiceEngine${suffix}`);
    return { cost: e.BUY_COST_MULT, superCost: e.SUPER_BUY_COST_MULT, spins: 10, cap: e.MAX_WIN_MULTIPLIER, trigger: 4, retrigger: 3, cumulative: true,
      spin(rng, bonus, superBonus, bank, n, params) {
        const s = e.spin(10000, { rng, isFreeSpin: bonus, superBonus, freeSpinMultiplier: bank, serverSeed: `audit-${n}`, clientSeed: "audit", nonce: n, payScale: 1 });
        return { raw: s.baseWin / 10000, plaques: s.multipliers.collected, scatters: s.scatterCount, jackpots: s.jackpotSymbolCount };
      }, resolve: e.resolvePayoutMultiplier };
  }
  if (game === "golden-tree") {
    const c = require(`../games/goldenTree/constants${suffix}`), e = require(`../games/goldenTree/spinEngine${suffix}`), w = require(`../games/goldenTree/winGuard${suffix}`);
    return { cost: c.BUY_BONUS_COST, spins: c.FREE_SPINS_PER_BONUS, cap: c.MAX_WIN_MULTIPLIER, trigger: Infinity, retrigger: Infinity,
      spin(rng, bonus, superBonus, bank, n, params) {
        const s = e.generateSpin({ rng: max => Math.floor(rng() * max), bonusMode: bonus, edgeParams: params });
        const win = w.hardenWinResult(s.matrix, s.wildMultipliers, 10000, { bonusMode: bonus, payScale: 1, tierName: params?.tierName });
        return { raw: win.totalWin / 10000, plaques: 0, scatters: 0, jackpots: s.matrix.flat().filter(c => c === "jackpot").length };
      }, resolve: ({ carried }) => ({ applied: 1, nextCarried: carried }) };
  }
  const c = require(`../games/${game}/constants${suffix}`), e = require(`../games/${game}/spinEngine${suffix}`);
  return { cost: c.BUY_BONUS_COST, superCost: c.SUPER_BUY_BONUS_COST, spins: c.FREE_SPINS_BOUGHT, cap: c.MAX_WIN_MULTIPLIER, trigger: c.TRIGGER_NATURAL_MIN, retrigger: c.TRIGGER_RETRIGGER_MIN,
    spin(rng, bonus, superBonus, bank, n, params) {
      const s = e.resolveSpin({ rng, bonusMode: bonus, superBonus, edgeParams: params, payScale: 1 });
      return { raw: s.baseWin, plaques: s.multiplierSum, scatters: s.scatterCount, jackpots: s.finalMatrix.flat().filter(c => c === "jackpot").length };
    }, resolve: c.resolvePayoutMultiplier };
}
function samples(game, { rounds, seed, bonus, superBonus = false, version = 2, tier = "default", bet = 10000 }) {
  const a = adapter(game, version), rng = rngFor(seed), episodes = [];
  let nonce = seed * 10000000;
  const params = game === "zeus" || tier === "default" || bonus ? null : edge.calculateEdge({ game, betAmount: bet, userId: null });
  const bonusParams = version === 1 && game !== "zeus" ? edge.calculateEdge({ game, betAmount: bet, userId: null, isBonusSpin: true, economyVersion: 1 }) : null;
  for (let i = 0; i < rounds; i++) {
    let left = bonus ? a.spins : 1, bank = 0, natural = false;
    const spins = [];
    for (let guard = 0; left > 0; guard++) {
      if (guard >= 10000) throw new Error(`${game}: session failed to terminate; audit rejected`);
      const isBonus = bonus || natural;
      const activeParams = isBonus ? bonusParams : params;
      const s = a.spin(rng, isBonus, superBonus, bank, nonce++, activeParams);
      const resolved = a.resolve({ baseWin: s.raw, plaqueSum: s.plaques, carried: bank, isFreeSpin: isBonus });
      bank = resolved.nextCarried;
      let applied = resolved.applied;
      if (version === 1 && game === "zenobia" && activeParams?.highMultiplierDampening < 1 && applied > 1) {
        applied = Math.max(1, Math.round(1 + (applied - 1) * activeParams.highMultiplierDampening));
      }
      spins.push({ raw: s.raw * applied, bonus: isBonus, jackpot: s.jackpots >= 3 ? 1600 / 3 : 0 });
      if (isBonus && s.scatters >= a.retrigger) left = a.cumulative ? Math.min(50, left + 5) : left + 5;
      left--;
      if (!isBonus && s.scatters >= a.trigger) { left += a.spins; natural = true; }
    }
    episodes.push(spins);
  }
  return { episodes, a, params, bonusParams, game, bonus, superBonus, version, tier, bet };
}
function measure(data, scale, profile) {
  const { a, params, bonusParams, game, bonus, superBonus, version, bet } = data;
  const price = bonus ? (superBonus ? a.superCost : a.cost) : 1;
  let sum = 0, squares = 0, big = 0, maximum = 0, capped = 0;
  for (const spins of data.episodes) {
    let won = 0, roundWon = 0;
    for (const s of spins) {
      let chosenScale = scale;
      if (!bonus && s.bonus && version === 2) chosenScale = profile.bonus;
      let win = s.raw * chosenScale;
      const activeParams = s.bonus ? bonusParams : params;
      if (version === 1 && activeParams?.modulateWinMultiple && game === "zenobia") win = activeParams.modulateWinMultiple(win);
      const cap = game === "zenobia" && (!s.bonus || version === 1) ? Math.min(a.cap, activeParams?.winCapMultiplier || a.cap) : a.cap;
      if (win > cap) capped++;
      win = Math.min(win, cap);
      // REST wallets use integer coins, Zeus ledger also settles integer coins.
      win = Math.round(win * bet) / bet;
      if (a.cumulative && s.bonus) {
        win = Math.min(win, Math.max(0, a.cap - roundWon));
      }
      won += win + s.jackpot;
      roundWon += win;
      if (a.cumulative && roundWon >= a.cap) break;
    }
    const ratio = won / price;
    sum += ratio; squares += ratio * ratio;
    if (won >= 100) big++;
    maximum = Math.max(maximum, won);
  }
  const n = data.episodes.length, mean = sum / n;
  const halfWidth = 1.96 * Math.sqrt(Math.max(0, (squares - n * mean * mean) / (n - 1)) / n);
  return { game, mode: bonus ? superBonus ? "super" : "bonus" : "base", tier: data.tier, bet, version, rounds: n, rtp: mean, ci95: [mean - halfWidth, mean + halfWidth], halfWidth, bigWinRate: big / n, maxWinX: maximum, cappedSpins: capped };
}
function solve(data, target, profile) {
  let lo = 0, hi = 1;
  while (measure(data, hi, profile).rtp < target) { hi *= 2; if (hi > 1e6) throw new Error("Unreachable RTP"); }
  for (let i = 0; i < 34; i++) { const mid = (lo + hi) / 2; if (measure(data, mid, profile).rtp < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function main() {
  const calibrate = process.argv.includes("--calibrate"), baseline = process.argv.includes("--baseline");
  const rounds = Number(process.argv.find(s => /^--rounds=/.test(s))?.split("=")[1] || 30000);
  const seed = Number(process.argv.find(s => /^--seed=/.test(s))?.split("=")[1] || 123);
  const seeds = (process.argv.find(s => /^--seeds=/.test(s))?.split("=")[1] || String(seed)).split(",").map(Number);
  const bonusOnly = process.argv.includes("--bonus-only");
  const bonusBets = (process.argv.find(s => /^--bets=/.test(s))?.split("=")[1] || "10000").split(",").map(Number);
  const selected = process.argv.find(s => /^--game=/.test(s))?.split("=")[1];
  const version = baseline ? 1 : 2, profiles = JSON.parse(fs.readFileSync(calibrationPath)), results = [];
  for (const game of selected ? [selected] : ["zeus", "poseidon", "zenobia", "golden-tree"]) {
    const profile = profiles[game];
    for (const superBonus of process.argv.includes("--base-only") ? [] : game === "golden-tree" ? [false] : [false, true]) {
      const batches = seeds.map(seed => samples(game, { rounds, seed, bonus: true, superBonus, version }));
      const data = { ...batches[0], episodes: batches.flatMap(b => b.episodes) };
      const mode = superBonus ? "super" : "bonus";
      if (calibrate) profile[mode] = solve(data, economy.BONUS_RTP, profile);
      for (const bet of bonusBets) {
        const report = measure({ ...data, bet }, baseline ? 1 : profile[mode], profile);
        results.push(report); console.log(JSON.stringify(report));
      }
    }
    for (const [tier, bet, target] of bonusOnly ? [] : [["default", 10000, game === "golden-tree" ? 0.9649 : 0.965], ...(game === "zeus" ? [] : [["micro",10000,0.975],["low",50000,0.945],["mid",200000,0.895],["high",1000000,0.815]])]) {
      const batches = seeds.map(seed => samples(game, { rounds: rounds * 3, seed, bonus: false, version, tier, bet }));
      const data = { ...batches[0], episodes: batches.flatMap(b => b.episodes) };
      const name = data.params?.tierName || "default";
      if (calibrate) profile.base[name] = solve(data, target, profile);
      const report = measure(data, baseline ? 1 : (profile.base[name] ?? profile.base.default), profile);
      results.push(report); console.log(JSON.stringify(report));
    }
  }
  if (calibrate) {
    const latest = JSON.parse(fs.readFileSync(calibrationPath));
    for (const game of selected ? [selected] : Object.keys(profiles)) latest[game] = profiles[game];
    fs.writeFileSync(calibrationPath, JSON.stringify(latest, null, 2) + "\n");
  }
  const out = process.argv.find(s => /^--out=/.test(s))?.slice(6);
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), seeds, calibration: profiles, results }, null, 2) + "\n");
  if (!baseline && !calibrate && results.some(r => r.mode !== "base" && (r.rtp < 0.44 || r.rtp > 0.48 || r.halfWidth > 0.02))) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { main, rngFor, adapter, samples, measure, solve };
