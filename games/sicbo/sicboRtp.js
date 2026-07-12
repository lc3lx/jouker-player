/**
 * Sic Bo RTP / house-edge tracking + offline simulation helper.
 *
 * recordRound aggregates each settled round into the shared CasinoGameStats doc
 * (gameKey "sicbo") so admin monitoring can compute realised RTP. simulate() runs
 * the pure engine over N random rounds to verify theoretical RTP for a bet type.
 */
const CasinoGameStats = require("../../models/casinoGameStatsModel");
const { rollDice, evaluateBet } = require("./sicboEngine");
const { generateServerSeed } = require("./sicboSeed");

const GAME_KEY = "sicbo";

/**
 * Fold one settled round's economy into CasinoGameStats.
 * @param {{ totalBetAmount:number, totalPayout:number }} round
 */
async function recordRound({ totalBetAmount, totalPayout }) {
  const bet = Math.max(0, Math.floor(Number(totalBetAmount) || 0));
  const payout = Math.max(0, Math.floor(Number(totalPayout) || 0));
  await CasinoGameStats.findOneAndUpdate(
    { gameKey: GAME_KEY },
    { $inc: { totalBet: bet, totalPayout: payout, spinCount: 1 } },
    { upsert: true, new: true }
  );
}

/** Realised RTP + house edge from the aggregate stats doc. */
async function getRealisedRtp() {
  const doc = await CasinoGameStats.findOne({ gameKey: GAME_KEY }).lean();
  const totalBet = Number(doc?.totalBet) || 0;
  const totalPayout = Number(doc?.totalPayout) || 0;
  const rtp = totalBet > 0 ? totalPayout / totalBet : 0;
  return {
    totalBet,
    totalPayout,
    rounds: Number(doc?.spinCount) || 0,
    rtp,
    houseEdge: totalBet > 0 ? 1 - rtp : 0,
  };
}

/**
 * Monte-Carlo the theoretical RTP for a single bet type over N rolls (pure engine).
 * Used in tests to assert payouts land in the expected house-edge band.
 * @param {string} betType
 * @param {number} rounds
 * @returns {{ betType, rounds, rtp, houseEdge }}
 */
function simulate(betType, rounds = 200000) {
  const seed = generateServerSeed();
  const unit = 1;
  let staked = 0;
  let returned = 0;
  for (let i = 0; i < rounds; i += 1) {
    const dice = rollDice(seed, "sim", String(i));
    const { won, multiplier } = evaluateBet(betType, dice);
    staked += unit;
    if (won) returned += unit + unit * multiplier; // stake back + winnings
  }
  const rtp = returned / staked;
  return { betType, rounds, rtp, houseEdge: 1 - rtp };
}

module.exports = {
  GAME_KEY,
  recordRound,
  getRealisedRtp,
  simulate,
};
