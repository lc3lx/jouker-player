/**
 * Trix state table. Exports the CURRENT string values used by TrixGame.js
 * (games/trix/TrixGame.js) as named constants for readability - values are
 * not renamed, since they're read directly by tests and the Flutter client
 * via getGameState().
 *
 * Verified transition table (from TrixGame.js startRound/applyMove/nextRound):
 *   waiting -> selecting_game -> playing -> round_end -> {selecting_game | game_end}
 */
const STATE = Object.freeze({
  WAITING: "waiting",
  SELECTING_GAME: "selecting_game",
  PLAYING: "playing",
  ROUND_END: "round_end",
  GAME_END: "game_end",
});

const TRANSITIONS = {
  [STATE.WAITING]: [STATE.SELECTING_GAME],
  [STATE.SELECTING_GAME]: [STATE.PLAYING],
  [STATE.PLAYING]: [STATE.ROUND_END],
  [STATE.ROUND_END]: [STATE.SELECTING_GAME, STATE.GAME_END],
  [STATE.GAME_END]: [],
};

module.exports = { STATE, TRANSITIONS };
