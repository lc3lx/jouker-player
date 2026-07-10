/**
 * King Earth — seeded Monte-Carlo RTP harness (manual, not part of `node --test`).
 *
 *   node test/kingEarth.rtp.js [rounds] [bet] [volatility] [mode]
 *   mode = base | ante | buy      (default base)
 *
 * Replicates the `dice_spin` handler's free-spins session flow so the reported
 * RTP includes the bonus contribution:
 *   - base spin costs `stake`; 4+ scatters open a 15-spin session
 *   - free spins cost 0, carry a persistent multiplier, retrigger +5 on 3+ scatter
 *   - the whole round win is capped at 4000× stake
 */

const DiceEngine = require("../games/dice/DiceEngine");

const ROUNDS = Number(process.argv[2] || 500000);
const BET = Number(process.argv[3] || 1);
const VOL = process.argv[4] || "medium";
const MODE = process.argv[5] || "base"; // base | ante | buy

const MAX_BANKED_FREE_SPINS = 50;

function runFreeSpins(bet, doubleChance, volatility, seedBase, startMultiplier, roundCapLeft) {
  // returns { win, spins, retriggers } — win is the bonus payout (already capped)
  const stake = Math.round(bet * (doubleChance ? 1.25 : 1) * 100) / 100;
  let remaining = DiceEngine.FREE_SPINS_AWARD;
  let totalMultiplier = startMultiplier;
  let win = 0;
  let spins = 0;
  let retriggers = 0;
  let capLeft = roundCapLeft;

  while (remaining > 0 && capLeft > 0) {
    const outcome = DiceEngine.spin(bet, {
      serverSeed: `${seedBase}-fs-${spins}`,
      clientSeed: "sim",
      nonce: `${spins + 1}`,
      doubleChance,
      isFreeSpin: true,
      freeSpinMultiplier: totalMultiplier,
      volatility,
    });
    let payout = outcome.totalWin;
    if (payout > capLeft) payout = capLeft;
    win += payout;
    capLeft -= payout;
    totalMultiplier = outcome.multipliers.freeSpinTotal;
    spins += 1;

    if (outcome.scatterCount >= DiceEngine.RETRIGGER_MIN_SCATTER) {
      remaining = Math.min(remaining + DiceEngine.RETRIGGER_AWARD, MAX_BANKED_FREE_SPINS);
      retriggers += 1;
    }
    remaining -= 1;
  }
  return { win, spins, retriggers };
}

function simulate() {
  const doubleChance = MODE === "ante";
  const stake = Math.round(BET * (doubleChance ? 1.25 : 1) * 100) / 100;
  const roundCap = DiceEngine.MAX_WIN_MULTIPLIER * stake;

  let totalBet = 0;
  let totalWin = 0;
  let hits = 0;
  let triggers = 0;
  let baseContribution = 0;
  let bonusContribution = 0;
  let maxRoundWin = 0;
  let totalFsSpins = 0;

  for (let i = 0; i < ROUNDS; i++) {
    let cost;
    let roundWin = 0;
    let capLeft = roundCap;

    if (MODE === "buy") {
      // Buy feature: pay 100× total bet, jump straight to free spins.
      cost = DiceEngine.BUY_COST_MULT * stake;
      const fs = runFreeSpins(BET, doubleChance, VOL, `buy${i}`, 0, capLeft);
      roundWin += fs.win;
      bonusContribution += fs.win;
      totalFsSpins += fs.spins;
    } else {
      cost = stake;
      const outcome = DiceEngine.spin(BET, {
        serverSeed: `s${i}`,
        clientSeed: "sim",
        nonce: `${i + 1}`,
        doubleChance,
        isFreeSpin: false,
        volatility: VOL,
      });
      let basePayout = outcome.totalWin;
      if (basePayout > capLeft) basePayout = capLeft;
      roundWin += basePayout;
      capLeft -= basePayout;
      baseContribution += basePayout;

      if (outcome.scatterCount >= 4) {
        triggers += 1;
        const fs = runFreeSpins(BET, doubleChance, VOL, `s${i}`, 0, capLeft);
        roundWin += fs.win;
        bonusContribution += fs.win;
        totalFsSpins += fs.spins;
      }
    }

    totalBet += cost;
    totalWin += roundWin;
    if (roundWin > 0) hits += 1;
    if (roundWin > maxRoundWin) maxRoundWin = roundWin;
  }

  const rtp = totalWin / totalBet;
  const pct = (x) => `${(100 * x).toFixed(2)}%`;
  console.log(`King Earth RTP sim — mode=${MODE} vol=${VOL} bet=${BET} rounds=${ROUNDS.toLocaleString()}`);
  console.log(`  RTP                : ${pct(rtp)}`);
  console.log(`  Hit rate           : ${pct(hits / ROUNDS)}`);
  if (MODE !== "buy") {
    console.log(`  FS trigger rate    : ${pct(triggers / ROUNDS)}  (~1 in ${triggers ? Math.round(ROUNDS / triggers) : "∞"})`);
    console.log(`  Base contribution  : ${pct(baseContribution / totalBet)}`);
    console.log(`  Bonus contribution : ${pct(bonusContribution / totalBet)}`);
  }
  console.log(`  Avg FS spins/round : ${(totalFsSpins / ROUNDS).toFixed(3)}`);
  console.log(`  Max round win      : ${maxRoundWin.toFixed(2)} (${(maxRoundWin / stake).toFixed(1)}× stake, cap ${DiceEngine.MAX_WIN_MULTIPLIER}×)`);
}

simulate();
