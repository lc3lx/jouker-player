/**
 * Tarneeb41 state table. Exports the CURRENT string values used by
 * Tarneeb41Game.js (games/tarneeb41/Tarneeb41Game.js) as named constants for
 * readability - values are not renamed, since "bidding_syrian" etc. are
 * serialized directly into getGameState() and consumed by the Flutter client.
 *
 * Verified transition table (from startGameCountdown/_onCountdownElapsed/
 * dealRound/_executeMove/endRound):
 *   waiting -> countdown -> {waiting | bidding_syrian}
 *   bidding_syrian -> bidding_syrian (self-loop: redeal when declared sum < SUM_MIN_TO_PLAY)
 *   bidding_syrian -> playing
 *   playing -> round_end
 *   round_end -> {bidding_syrian | game_end}
 */
const STATE = Object.freeze({
  WAITING: "waiting",
  COUNTDOWN: "countdown",
  BIDDING_SYRIAN: "bidding_syrian",
  PLAYING: "playing",
  ROUND_END: "round_end",
  GAME_END: "game_end",
});

const TRANSITIONS = {
  [STATE.WAITING]: [STATE.COUNTDOWN],
  [STATE.COUNTDOWN]: [STATE.WAITING, STATE.BIDDING_SYRIAN],
  [STATE.BIDDING_SYRIAN]: [STATE.BIDDING_SYRIAN, STATE.PLAYING],
  [STATE.PLAYING]: [STATE.ROUND_END],
  [STATE.ROUND_END]: [STATE.BIDDING_SYRIAN, STATE.GAME_END],
  [STATE.GAME_END]: [],
};

module.exports = { STATE, TRANSITIONS };
