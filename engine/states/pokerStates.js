/**
 * Poker state table - READ-ONLY MIRROR for documentation/tooling purposes.
 *
 * PokerTable (sockets/tableGame.js) already implements a correct, enforced
 * FSM via its own `static get ROUND_TRANSITIONS()` + `setRound()`. This file
 * does not enforce anything and is not wired into PokerTable - it exists so
 * the three games' state tables are discoverable in one place (engine/states/).
 * If PokerTable's ROUND_TRANSITIONS ever changes, update this mirror to match.
 */
const STATE = Object.freeze({
  IDLE: "idle",
  PREFLOP: "preflop",
  FLOP: "flop",
  TURN: "turn",
  RIVER: "river",
  SHOWDOWN: "showdown",
});

const TRANSITIONS = {
  [STATE.IDLE]: [STATE.PREFLOP],
  [STATE.PREFLOP]: [STATE.FLOP],
  [STATE.FLOP]: [STATE.TURN],
  [STATE.TURN]: [STATE.RIVER],
  [STATE.RIVER]: [STATE.SHOWDOWN],
  [STATE.SHOWDOWN]: [STATE.IDLE],
};

module.exports = { STATE, TRANSITIONS };
