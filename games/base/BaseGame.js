/**
 * BaseGame - abstract base for all card games.
 * Extend this class to implement specific games (Tarneeb, Trix, etc.)
 */
class BaseGame {
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
}

module.exports = BaseGame;
