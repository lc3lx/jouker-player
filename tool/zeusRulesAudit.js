"use strict";
const fs = require("node:fs");
const engine = require("../games/dice/DiceEngine");
const { stageSpinSession } = require("../games/dice/kingArthSettlement");
const { MATCH_PRIZE_TYPES } = require("../games/poseidon/jackpot/jackpotSelector");

function rngFor(seed) {
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function session({ mode, bet, version, rng, jackpotRng, spinEngine = engine }) {
  const superBonus = mode === "super", bought = mode !== "base";
  let current = bought ? { remaining: engine.FREE_SPINS_BOUGHT, totalMultiplier: 0, roundWon: 0,
    roundCap: bet * engine.MAX_WIN_MULTIPLIER, lockedBaseBet: bet, superBonus, economyVersion: version } : null;
  let payout = 0, jackpotPayout = 0, spins = 0, jackpots = 0, capped = false;
  do {
    if (++spins > 10000) throw new Error("Incomplete bonus session: audit rejected");
    const outcome = spinEngine.spin(bet, { rng, isFreeSpin: !!current, superBonus: !!current?.superBonus,
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
function measure({ mode, bet = 10000, version = engine.ECONOMY_VERSION, rounds = 10000, seeds = [11, 29, 71], spinEngine = engine }) {
  let sum = 0, squares = 0, slots = 0, jackpot = 0, spins = 0, triggers = 0, capSessions = 0, bigSessions = 0, maximum = 0;
  for (const seed of seeds) {
    const rng = rngFor(seed), jackpotRng = rngFor(seed ^ 0x9E3779B9);
    for (let i = 0; i < rounds; i++) {
      const r = session({ mode, bet, version, rng, jackpotRng, spinEngine });
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
    halfWidth, jackpotMethod: "equally likely first-triple tier from production prize multipliers", targetRtp: version >= 4 ? spinEngine.TARGET_RTP[mode] : version === 3 ? null : mode === "base" ? 0.965 : 0.46 };
}
// Stratified sampling prevents the rare free-bonus/jackpot events from dominating
// Monte Carlo error. Only their initial RNG draws are conditioned; every grid,
// payout, cascade and complete bonus session still uses the production engine.
function measureBase({ bet = 10000, rounds = 1000, seeds = [11,29,71], spinEngine = engine, strataCache } = {}) {
  const pBonus = spinEngine.NATURAL_BONUS_PROBABILITY;
  const pJackpot = spinEngine.JACKPOT_WIN_PROBABILITY, pAppearance = spinEngine.JACKPOT_APPEARANCE_PROBABILITY;
  const ranges = [[0,pJackpot], [pJackpot,pAppearance], [pAppearance,1]];
  const faceWeights=[...spinEngine.BASE_MULTIPLIER_WEIGHTS];
  faceWeights.push(100-faceWeights.reduce((a,b)=>a+b,0));
  let cumulative=0;
  const faces=faceWeights.map(p=>{ const lo=cumulative; cumulative+=p/100; return [lo,cumulative]; });
  let rtp=0, variance=0, slotRtp=0, jackpotRtp=0, expectedSpins=0, bigWinRate=0, maximum=0, sessions=0;
  const strata=[];
  for (let face=0; face<faces.length; face++) for (const natural of [false,true]) for (let j=0; j<ranges.length; j++) {
    const [lo,hi]=ranges[j], [faceLo,faceHi]=faces[face];
    const weight=(faceHi-faceLo)*(hi-lo)*(natural ? pBonus : 1-pBonus);
    if (weight === 0) continue;
    let sum=0,squares=0,slots=0,jp=0,spins=0,big=0,stratumMax=0;
    const cached=strataCache?.find(s=>s.face===face && s.natural===natural && s.jackpotClass===j);
    if(cached) ({sum,squares,slots,jp,spins,big,stratumMax}=cached);
    else for(const seed of seeds) {
      const rng=rngFor(seed + j*100003 + Number(natural)*700001 + face*10000019), jackpotRng=rngFor(seed ^ (j+Number(natural)*3+face*6+1)*7919);
      for(let i=0;i<rounds;i++) {
        let draws=0;
        const conditioned=()=>{
          const value=rng(); draws++;
          if(draws===1) return faceLo+(faceHi-faceLo)*value;
          if(draws===2) return lo+(hi-lo)*value;
          if(draws===(j===1 ? 4 : 3)) return natural ? pBonus*value : pBonus+(1-pBonus)*value;
          return value;
        };
        const r=session({mode:"base",bet,version:spinEngine.ECONOMY_VERSION,rng:conditioned,jackpotRng,spinEngine});
        const ratio=(r.payout+r.jackpotPayout)/bet;
        sum+=ratio;squares+=ratio*ratio;slots+=r.payout/bet;jp+=r.jackpotPayout/bet;spins+=r.spins;
        big+=Number(ratio>=100);stratumMax=Math.max(stratumMax,ratio);
      }
    }
    const n=cached?.sessions || rounds*seeds.length,mean=sum/n;
    sessions+=n;rtp+=weight*mean;slotRtp+=weight*slots/n;jackpotRtp+=weight*jp/n;maximum=Math.max(maximum,stratumMax);
    variance+=weight*weight*Math.max(0,(squares-n*mean*mean)/(n-1))/n;
    expectedSpins+=weight*spins/n;bigWinRate+=weight*big/n;
    strata.push({face,natural,jackpotClass:j,weight,sessions:n,rtp:mean,spins,sum,squares,slots,jp,big,stratumMax});
  }
  const halfWidth=1.96*Math.sqrt(variance);
  return {game:"zeus",mode:"base",version:spinEngine.ECONOMY_VERSION,bet,sessions,completedSessions:sessions,
    method:"stratified initial multiplier, natural-bonus and jackpot draws; complete production settlement",rtp,slotRtp,jackpotRtp,
    halfWidth,ci95:[rtp-halfWidth,rtp+halfWidth],expectedSpins,bigWinRate,maxWinX:maximum,strata,targetRtp:spinEngine.TARGET_RTP?.base ?? null};
}
function main() {
  const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=")[1] || fallback;
  const rounds = Number(arg("rounds", "10000")), seeds = arg("seeds", "11,29,71").split(",").map(Number);
  const bets = arg("bets", "10000,1000000").split(",").map(Number);
  const versions = process.argv.includes("--before-after") ? [3, engine.ECONOMY_VERSION] : [engine.ECONOMY_VERSION];
  const modes = arg("modes", "base,bonus,super").split(",");
  const results = [];
  for (const version of versions) for (const bet of bets) for (const mode of modes) {
    const result = mode === "base" && process.argv.includes("--stratified-base") && version === engine.ECONOMY_VERSION
      ? measureBase({ bet, rounds, seeds }) : measure({ mode, bet, version, rounds, seeds });
    results.push(result); console.log(JSON.stringify(result));
  }
  const out = arg("out", "");
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), seeds, results }, null, 2) + "\n");
}
if (require.main === module) main();
module.exports = { rngFor, session, measure, measureBase, main };
