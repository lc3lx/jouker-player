const CasinoGameStats = require("../../models/casinoGameStatsModel");

const GAME_KEY = "king-arth";

async function recordSpin(stake, payout) {
  await CasinoGameStats.findOneAndUpdate(
    { gameKey: GAME_KEY },
    {
      $inc: {
        totalBet: stake,
        totalPayout: payout,
        spinCount: 1,
      },
    },
    { upsert: true, new: true }
  );
}

async function recordBigWin(winType) {
  if (winType !== "big" && winType !== "mega") return;
  const field = winType === "mega" ? "megaWinCount" : "bigWinCount";
  await CasinoGameStats.findOneAndUpdate(
    { gameKey: GAME_KEY },
    { $inc: { [field]: 1 } },
    { upsert: true }
  );
}

module.exports = {
  GAME_KEY,
  recordSpin,
  recordBigWin,
};
