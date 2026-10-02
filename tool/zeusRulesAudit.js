"use strict";
const fs = require("node:fs");
const engine = require("../games/dice/DiceEngine");
const { stageSpinSession } = require("../games/dice/kingArthSettlement");
const { MATCH_PRIZE_TYPES } = require("../games/poseidon/jackpot/jackpotSelector");

function rngFor(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function session({ mode, bet, version, rng, jackpotRng }) {
  const superBonus = mode === "super", bought = mode !== "base";
  let current = bought ? { remaining: engine.FREE_SPINS_BOUGHT, totalMultiplier: 0, roundWon: 0,
    roundCap: bet * engine.MAX_WIN_MULTIPLIER, lockedBaseBet: bet, superBonus, economyVersion: version } : null;
  let payout = 0, jackpotPayout = 0, spins = 0, jackpots = 0, capped = false;
  do {
    if (++spins > 10000) throw new Error("Incomplete bonus session: audit rejected");
    const outcome = engine.spin(bet, { rng, isFreeSpin: !!current, superBonus: !!current?.superBonus,
      freeSpinMultiplier: current?.totalMultiplier || 0, economyVersion: version });
    const staged = stageSpinSession(current, { ...outcome, economyVersion: version }, outcome.totalWin, bet);
    payout += staged.payout;
    capped ||= staged.capReached;
    if (outcome.jackpotTriggered) {
      jackpots++;
      // The production scratch board has exactly three cards of each tier.
      // By symmetry, each tier is equally likely to be the first triple.
      const tier = MATCH_PRIZE_TYPES[Math.floor(jackpotRng() * MATCH_PRIZE_TYPES.length)];
      jackpotPayout += Math.round(bet * tier.multiplier);
    }
    current = staged.next;
  } while (current);
  const cost = bet * (bought ? superBonus ? engine.SUPER_BUY_COST_MULT : engine.BUY_COST_MULT : 1);
  return { cost, payout, jackpotPayout, spins, jackpots, capped };
}
function measure({ mode, bet = 10000, version = 3, rounds = 10000, seeds = [11, 29, 71] }) {
  let sum = 0, squares = 0, slots = 0, jackpot = 0, spins = 0, triggers = 0, capSessions = 0, bigSessions = 0, maximum = 0;
  for (const seed of seeds) {
    const rng = rngFor(seed), jackpotRng = rngFor(seed ^ 0x9E3779B9);
    for (let i = 0; i < rounds; i++) {
      const r = session({ mode, bet, version, rng, jackpotRng });
      const ratio = (r.payout + r.jackpotPayout) / r.cost;
      sum += ratio; squares += ratio * ratio;
      slots += r.payout / r.cost; jackpot += r.jackpotPayout / r.cost;
      spins += r.spins; triggers += r.jackpots; capSessions += Number(r.capped);
      bigSessions += Number((r.payout + r.jackpotPayout) / bet >= 100);
      maximum = Math.max(maximum, (r.payout + r.jackpotPayout) / bet);
    }
  }
  const n = rounds * seeds.length, mean = sum / n;
  const halfWidth = 1.96 * Math.sqrt(Math.max(0, (squares - n * mean * mean) / (n - 1)) / n);
  return { game: "zeus", mode, version, bet, sessions: n, completedSessions: n, spins,
    rtp: mean, slotRtp: slots / n, jackpotRtp: jackpot / n, ci95: [mean - halfWidth, mean + halfWidth],
    jackpotTriggers: triggers, capSessions, bigWinRate: bigSessions / n, maxWinX: maximum,
    jackpotMethod: "equally likely first-triple tier from production prize multipliers", targetRtp: version === 3 ? null : mode === "base" ? 0.965 : 0.46 };
}
function main() {
  const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] || fallback;
  const rounds = Number(arg("rounds", "10000")), seeds = arg("seeds", "11,29,71").split(",").map(Number);
  const bets = arg("bets", "10000,1000000").split(",").map(Number);
  const versions = process.argv.includes("--before-after") ? [2, 3] : [3];
  const results = [];
  for (const version of versions) for (const bet of bets) for (const mode of ["base", "bonus", "super"]) {
    const result = measure({ mode, bet, version, rounds, seeds });
    results.push(result); console.log(JSON.stringify(result));
  }
  const out = arg("out", "");
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), seeds, results }, null, 2) + "\n");
}
if (require.main === module) main();
module.exports = { rngFor, session, measure, main };
