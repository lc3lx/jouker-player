/**
 * Golden Tree jackpot — shared Poseidon match-3 scratch (same as Zeus / Atlantis).
 * Trigger: 3+ "jackpot" cells on the final 5×3 matrix.
 */

const jackpotService = require("../poseidon/jackpot/jackpotService");
const { settleJackpotRound } = require("../poseidon/jackpot/jackpotSettlement");
const {
  JACKPOT_MIN_SYMBOLS,
  JACKPOT_SYMBOL,
} = require("../poseidon/jackpot/jackpotConstants");
const { SYMBOLS } = require("./constants");

const JP = SYMBOLS.JACKPOT || JACKPOT_SYMBOL;

function countJackpotSymbols(matrix) {
  let count = 0;
  if (!Array.isArray(matrix)) return 0;
  for (const col of matrix) {
    if (!Array.isArray(col)) continue;
    for (const cell of col) {
      if (cell === JP) count += 1;
    }
  }
  return count;
}

function isJackpotTriggered(matrix) {
  return countJackpotSymbols(matrix) >= (JACKPOT_MIN_SYMBOLS || 3);
}

async function createRoundForSpin({ spinId, userId }) {
  return jackpotService.createJackpotRound({
    spinId,
    userId,
    game: "golden-tree",
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
  countJackpotSymbols,
  isJackpotTriggered,
  createRoundForSpin,
  recoverRound,
  revealCard,
  settleRound,
};
