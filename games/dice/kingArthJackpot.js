/**
 * King Arth jackpot — shared Poseidon match-3 service (same jackpot as
 * Atlantis / Golden Tree). Trigger: 3+ JACKPOT cells on DiceEngine finalGrid.
 */

const DiceEngine = require("./DiceEngine");
const jackpotService = require("../poseidon/jackpot/jackpotService");
const { settleJackpotRound } = require("../poseidon/jackpot/jackpotSettlement");
const { JACKPOT_MIN_SYMBOLS } = require("../poseidon/jackpot/jackpotConstants");

function isJackpotTriggered(finalGrid) {
  return DiceEngine.countJackpotSymbols(finalGrid) >= (JACKPOT_MIN_SYMBOLS || 3);
}

async function createRoundForSpin({ spinId, userId }) {
  return jackpotService.createJackpotRound({
    spinId,
    userId,
    game: "king-arth",
  });
}

async function recoverRound(roundId, userId) {
  return jackpotService.recoverJackpotRound(roundId, userId);
}

async function revealCard(roundId, userId, cardIndex) {
  return jackpotService.revealJackpotCard(roundId, userId, cardIndex);
}

async function settleRound(roundId, userId) {
  return settleJackpotRound(roundId, userId);
}

module.exports = {
  isJackpotTriggered,
  createRoundForSpin,
  recoverRound,
  revealCard,
  settleRound,
};
