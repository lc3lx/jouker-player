/**
 * BaseGameEngine - abstract root for all game engines (Trix, Tarneeb41, future games).
 *
 * Strict superset of games/base/BaseGame.js: same constructor signature and
 * player-lifecycle methods, so existing games can swap `extends BaseGame` for
 * `extends BaseGameEngine` with no other changes required.
 *
 * The additional hooks below are optional/default - each generalizes an
 * existing concrete method elsewhere in the codebase (see engine/README.md
 * for the full mapping table). Games are not required to override them this
 * phase; defaults are inert no-ops or throw-stubs matching BaseGame's
 * existing contract.
 */
class BaseGameEngine {
  constructor(roomId, gameType, options = {}) {
    this.roomId = roomId;
    this.gameType = gameType;
    this.options = options;
    this.state = "waiting"; // waiting | dealing | bidding | playing | round_end | game_end
    this.players = []; // [{ userId, socketId, seatIndex }]
    this.maxPlayers = 4;
  }

  /** Override: required player count for this game */
  getRequiredPlayers() {
    return 4;
  }

  /** Override: validate and apply a move */
  validateMove(playerIndex, action, payload) {
    throw new Error("validateMove must be implemented");
  }

  /** Override: apply a move and advance state */
  applyMove(playerIndex, action, payload) {
    throw new Error("applyMove must be implemented");
  }

  /** Override: get public state for a specific player (never include others' cards) */
  getGameState(forPlayerIndex) {
    throw new Error("getGameState must be implemented");
  }

  /** Override: check if game is finished */
  isGameFinished() {
    return this.state === "game_end";
  }

  addPlayer(userId, socketId) {
    if (this.players.length >= this.maxPlayers) return -1;
    const seatIndex = this.players.length;
    this.players.push({ userId, socketId, seatIndex });
    return seatIndex;
  }

  removePlayer(userId) {
    const idx = this.players.findIndex((p) => String(p.userId) === String(userId));
    if (idx >= 0) this.players.splice(idx, 1);
    return idx;
  }

  getPlayerByUserId(userId) {
    return this.players.find((p) => String(p.userId) === String(userId));
  }

  getPlayerIndex(userId) {
    const p = this.getPlayerByUserId(userId);
    return p ? p.seatIndex : -1;
  }

  // --- Optional/default hooks (forward-looking; unused by current games unless overridden) ---

  /** Override: seat + sync a joining player. Default no-op (games handle this at the call site today). */
  joinPlayer(userId, socketId) {}

  /** Override: convert a leaving human to a bot or remove them. Default no-op. */
  leavePlayer(userId) {}

  /** Override: restore a human at their seat on reconnect. Default no-op. */
  reconnectPlayer(userId, socketId) {}

  /** Override: centralize end-of-game bookkeeping (timer clear, _finishedAt). Default no-op. */
  endGame() {}

  /** Override: settlement orchestration hook. Default no-op - settlement stays in services/gameSettlementService.js this phase. */
  settlement() {}

  /** Override: start the active player's turn timer. Default no-op. */
  startTurnTimer() {}

  /** Override: stop the active player's turn timer. Default no-op. */
  stopTurnTimer() {}

  /** Override: pause the game (no current equivalent besides Poker's `frozen` flag). Default no-op. */
  pauseGame() {}

  /** Override: resume a paused game. Default no-op. */
  resumeGame() {}

  /** Override: broadcast current state to all seated players. Default no-op. */
  emitState() {}

  /** Override: produce a serializable snapshot of game state. Default: not implemented this phase. */
  serialize() {
    return null;
  }

  /** Override: restore game state from a snapshot produced by serialize(). Default: not implemented this phase. */
  deserialize(data) {}

  /** Override: release all resources held by this game instance (timers, listeners). */
  destroy() {}
}

module.exports = BaseGameEngine;
