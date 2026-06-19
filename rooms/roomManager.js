/**
 * RoomManager - manages game rooms.
 * Each room: gameType, players, gameInstance, state
 */
const TarneebGame = require("../games/tarneeb/TarneebGame");
const TrixGame = require("../games/trix/TrixGame");
const { archiveTableDocument } = require("../services/tableLifecycleService");

const GAME_CLASSES = {
  tarneeb: TarneebGame,
  trix: TrixGame,
};

class Room {
  constructor(roomId, gameType) {
    this.roomId = roomId;
    this.gameType = gameType;
    this.state = "waiting"; // waiting | in_progress
    this.gameInstance = null;
    this.createdAt = Date.now();
  }

  createGame() {
    const GameClass = GAME_CLASSES[this.gameType];
    if (!GameClass) return null;
    this.gameInstance = new GameClass(this.roomId);
    return this.gameInstance;
  }

  getGame() {
    return this.gameInstance;
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> Room
    this.userToRoom = new Map(); // userId -> roomId
    this.roomCounter = 0;
    /** @type {Map<string, import('../games/trix/TrixGame')>} Mongo table _id -> TrixGame */
    this.trixGamesByTableId = new Map();
    /** @type {Map<string, string>} userId -> mongo table _id */
    this.userToTrixTableId = new Map();
    /** @type {Map<string, string>} userId -> socket.id for /game namespace (trix tables) */
    this.trixUserSocket = new Map();

    /** @type {Map<string, import('../games/tarneeb41/Tarneeb41Game')>} */
    this.tarneeb41GamesByTableId = new Map();
    this.userToTarneeb41TableId = new Map();
    this.tarneeb41UserSocket = new Map();
  }

  setTarneeb41UserSocket(userId, socketId) {
    if (socketId) this.tarneeb41UserSocket.set(String(userId), socketId);
  }

  getTarneeb41UserSocket(userId) {
    return this.tarneeb41UserSocket.get(String(userId)) || null;
  }

  deleteTarneeb41UserSocket(userId) {
    this.tarneeb41UserSocket.delete(String(userId));
  }

  getOrCreateTarneeb41Game(mongoTableId) {
    const key = String(mongoTableId);
    let game = this.tarneeb41GamesByTableId.get(key);
    if (!game) {
      const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
      const roomId = `tarneeb41_table_${key}`;
      game = new Tarneeb41Game(roomId, { mongoTableId: key });
      this.tarneeb41GamesByTableId.set(key, game);
    }
    return game;
  }

  getTarneeb41GameForTable(mongoTableId) {
    return this.tarneeb41GamesByTableId.get(String(mongoTableId)) || null;
  }

  setUserTarneeb41Table(userId, mongoTableId) {
    this.userToTarneeb41TableId.set(String(userId), String(mongoTableId));
  }

  getTarneeb41TableIdForUser(userId) {
    return this.userToTarneeb41TableId.get(String(userId)) || null;
  }

  getTarneeb41ContextForUser(userId) {
    const tid = this.getTarneeb41TableIdForUser(userId);
    if (!tid) return null;
    const game = this.getTarneeb41GameForTable(tid);
    if (!game) return null;
    return { game, tableId: tid };
  }

  leaveTarneeb41TableSocket(userId) {
    const tid = this.userToTarneeb41TableId.get(String(userId));
    if (!tid) return null;
    this.userToTarneeb41TableId.delete(String(userId));
    const game = this.tarneeb41GamesByTableId.get(tid);
    if (game) {
      const p = game.players.find((x) => String(x.userId) === String(userId));
      if (p) p.socketId = null;
    }
    void this.evictTarneeb41IfAbandoned(tid);
    this.tryClearTarneeb41GameIfReady(tid);
    this.evictExpiredTarneeb41Games();
    return { tableId: tid, game };
  }

  getTarneeb41FinishTtlMs() {
    const n = parseInt(process.env.GAME_TTL_AFTER_FINISH_MINUTES || "10", 10);
    const minutes = Number.isFinite(n) && n >= 1 ? Math.min(n, 1440) : 10;
    return minutes * 60 * 1000;
  }

  countHumansAtTarneeb41Table(mongoTableId) {
    let n = 0;
    const key = String(mongoTableId);
    for (const [, tid] of this.userToTarneeb41TableId.entries()) {
      if (tid === key) n += 1;
    }
    return n;
  }

  /** Humans with an active /game socket on this tarneeb41 table. */
  countConnectedHumansAtTarneeb41Table(mongoTableId) {
    const key = String(mongoTableId);
    const game = this.tarneeb41GamesByTableId.get(key);
    if (!game || !Array.isArray(game.players)) return 0;
    let n = 0;
    for (const p of game.players) {
      if (p.isBot || !p.userId) continue;
      if (this.tarneeb41UserSocket.has(String(p.userId))) n += 1;
    }
    return n;
  }

  markTarneeb41GameFinished(mongoTableId) {
    const game = this.getTarneeb41GameForTable(mongoTableId);
    if (game && game.state === "game_end" && !game._finishedAt) {
      game._finishedAt = Date.now();
    }
  }

  markTarneeb41SettlementComplete(mongoTableId) {
    const game = this.getTarneeb41GameForTable(mongoTableId);
    if (!game) return;
    game._settlementCompleted = true;
    if (!game._finishedAt) game._finishedAt = Date.now();
  }

  /**
   * Evict when settlement is done and no humans remain mapped to the table.
   * @returns {{ cleared: boolean, reason?: string }}
   */
  tryClearTarneeb41GameIfReady(mongoTableId) {
    const key = String(mongoTableId);
    const game = this.tarneeb41GamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "not_found" };
    if (game.state !== "game_end") return { cleared: false, reason: "not_finished" };
    if (!game._settlementCompleted) return { cleared: false, reason: "settlement_pending" };
    if (this.countHumansAtTarneeb41Table(key) > 0) {
      return { cleared: false, reason: "humans_present" };
    }
    return this.clearTarneeb41Game(key, { archiveReason: "game_complete" });
  }

  /** Evict immediately when all humans have left (socket + mapping). */
  evictTarneeb41IfAbandoned(mongoTableId) {
    const key = String(mongoTableId);
    if (this.countHumansAtTarneeb41Table(key) > 0) {
      return { cleared: false, reason: "humans_present" };
    }
    const game = this.tarneeb41GamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "not_found" };
    if (game.state === "game_end" && !game._settlementCompleted) {
      return { cleared: false, reason: "settlement_pending" };
    }
    return this.clearTarneeb41Game(key, { archiveReason: "abandoned" });
  }

  /**
   * Idempotent teardown: destroy timers/listeners, remove in-memory refs, archive Mongo doc.
   * @returns {{ cleared: boolean, reason?: string }}
   */
  clearTarneeb41Game(mongoTableId, { archiveReason = "game_complete" } = {}) {
    const key = String(mongoTableId);
    const game = this.tarneeb41GamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "already_cleared" };

    try {
      if (typeof game.destroy === "function") game.destroy();
    } catch (_) {
      // idempotent — ignore teardown errors on repeat calls
    }

    if (Array.isArray(game.players)) {
      for (const p of game.players) {
        if (!p.isBot && p.userId) {
          const uid = String(p.userId);
          if (this.userToTarneeb41TableId.get(uid) === key) {
            this.userToTarneeb41TableId.delete(uid);
          }
          this.tarneeb41UserSocket.delete(uid);
        }
      }
    }

    for (const [uid, tid] of [...this.userToTarneeb41TableId.entries()]) {
      if (tid === key) this.userToTarneeb41TableId.delete(uid);
    }

    this.tarneeb41GamesByTableId.delete(key);
    void archiveTableDocument(key, { reason: archiveReason }).catch(() => {});

    return { cleared: true };
  }

  /** TTL fallback for finished games that were not cleared by the primary path. */
  evictExpiredTarneeb41Games() {
    const ttlMs = this.getTarneeb41FinishTtlMs();
    const now = Date.now();
    let evicted = 0;
    for (const [tableId, game] of [...this.tarneeb41GamesByTableId.entries()]) {
      if (game.state !== "game_end") continue;
      const finishedAt = game._finishedAt;
      if (!finishedAt || now - finishedAt < ttlMs) continue;
      void this.clearTarneeb41Game(tableId, { archiveReason: "game_complete" });
      evicted += 1;
    }
    return evicted;
  }

  startTarneeb41TtlSweep(intervalMs = 60_000) {
    if (this._tarneeb41TtlSweepInterval) return;
    this._tarneeb41TtlSweepInterval = setInterval(() => {
      try {
        this.evictExpiredTarneeb41Games();
      } catch (_) {
        // ignore sweep errors
      }
    }, intervalMs);
    if (typeof this._tarneeb41TtlSweepInterval.unref === "function") {
      this._tarneeb41TtlSweepInterval.unref();
    }
  }

  stopTarneeb41TtlSweep() {
    if (this._tarneeb41TtlSweepInterval) {
      clearInterval(this._tarneeb41TtlSweepInterval);
      this._tarneeb41TtlSweepInterval = null;
    }
  }

  setTrixUserSocket(userId, socketId) {
    if (socketId) this.trixUserSocket.set(String(userId), socketId);
  }

  getTrixUserSocket(userId) {
    return this.trixUserSocket.get(String(userId)) || null;
  }

  deleteTrixUserSocket(userId) {
    this.trixUserSocket.delete(String(userId));
  }

  getOrCreateTrixGame(mongoTableId) {
    const key = String(mongoTableId);
    let game = this.trixGamesByTableId.get(key);
    if (!game) {
      const TrixGame = require("../games/trix/TrixGame");
      const roomId = `trix_table_${key}`;
      game = new TrixGame(roomId, { mongoTableId: key });
      this.trixGamesByTableId.set(key, game);
    }
    return game;
  }

  getTrixGameForTable(mongoTableId) {
    return this.trixGamesByTableId.get(String(mongoTableId)) || null;
  }

  setUserTrixTable(userId, mongoTableId) {
    this.userToTrixTableId.set(String(userId), String(mongoTableId));
  }

  getTrixTableIdForUser(userId) {
    return this.userToTrixTableId.get(String(userId)) || null;
  }

  /**
   * @returns {{ game: import('../games/trix/TrixGame'), tableId: string } | null}
   */
  getTrixContextForUser(userId) {
    const tid = this.getTrixTableIdForUser(userId);
    if (!tid) return null;
    const game = this.getTrixGameForTable(tid);
    if (!game) return null;
    return { game, tableId: tid };
  }

  leaveTrixTableSocket(userId) {
    const tid = this.userToTrixTableId.get(String(userId));
    if (!tid) return null;
    this.userToTrixTableId.delete(String(userId));
    const game = this.trixGamesByTableId.get(tid);
    if (game) {
      const p = game.players.find((x) => String(x.userId) === String(userId));
      if (p) p.socketId = null;
    }
    void this.evictTrixIfAbandoned(tid);
    this.tryClearTrixGameIfReady(tid);
    this.evictExpiredTrixGames();
    return { tableId: tid, game };
  }

  countHumansAtTrixTable(mongoTableId) {
    let n = 0;
    for (const [, tid] of this.userToTrixTableId.entries()) {
      if (tid === String(mongoTableId)) n += 1;
    }
    return n;
  }

  /** Humans with an active /game socket on this trix table. */
  countConnectedHumansAtTrixTable(mongoTableId) {
    const key = String(mongoTableId);
    const game = this.trixGamesByTableId.get(key);
    if (!game || !Array.isArray(game.players)) return 0;
    let n = 0;
    for (const p of game.players) {
      if (p.isBot || !p.userId) continue;
      if (this.trixUserSocket.has(String(p.userId))) n += 1;
    }
    return n;
  }

  markTrixGameFinished(mongoTableId) {
    const game = this.getTrixGameForTable(mongoTableId);
    if (game && game.state === "game_end" && !game._finishedAt) {
      game._finishedAt = Date.now();
    }
  }

  markTrixSettlementComplete(mongoTableId) {
    const game = this.getTrixGameForTable(mongoTableId);
    if (!game) return;
    game._settlementCompleted = true;
    if (!game._finishedAt) game._finishedAt = Date.now();
  }

  tryClearTrixGameIfReady(mongoTableId) {
    const key = String(mongoTableId);
    const game = this.trixGamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "not_found" };
    if (game.state !== "game_end") return { cleared: false, reason: "not_finished" };
    if (!game._settlementCompleted) return { cleared: false, reason: "settlement_pending" };
    if (this.countHumansAtTrixTable(key) > 0) {
      return { cleared: false, reason: "humans_present" };
    }
    return this.clearTrixGame(key, { archiveReason: "game_complete" });
  }

  evictTrixIfAbandoned(mongoTableId) {
    const key = String(mongoTableId);
    if (this.countHumansAtTrixTable(key) > 0) {
      return { cleared: false, reason: "humans_present" };
    }
    const game = this.trixGamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "not_found" };
    if (game.state === "game_end" && !game._settlementCompleted) {
      return { cleared: false, reason: "settlement_pending" };
    }
    return this.clearTrixGame(key, { archiveReason: "abandoned" });
  }

  clearTrixGame(mongoTableId, { archiveReason = "game_complete" } = {}) {
    const key = String(mongoTableId);
    const game = this.trixGamesByTableId.get(key);
    if (!game) return { cleared: false, reason: "already_cleared" };

    try {
      if (typeof game.destroy === "function") game.destroy();
    } catch (_) {
      // idempotent
    }

    if (Array.isArray(game.players)) {
      for (const p of game.players) {
        if (!p.isBot && p.userId) {
          const uid = String(p.userId);
          if (this.userToTrixTableId.get(uid) === key) {
            this.userToTrixTableId.delete(uid);
          }
          this.trixUserSocket.delete(uid);
        }
      }
    }

    for (const [uid, tid] of [...this.userToTrixTableId.entries()]) {
      if (tid === key) this.userToTrixTableId.delete(uid);
    }

    this.trixGamesByTableId.delete(key);
    void archiveTableDocument(key, { reason: archiveReason }).catch(() => {});

    return { cleared: true };
  }

  evictExpiredTrixGames() {
    const ttlMs = this.getTarneeb41FinishTtlMs();
    const now = Date.now();
    let evicted = 0;
    for (const [tableId, game] of [...this.trixGamesByTableId.entries()]) {
      if (game.state !== "game_end") continue;
      const finishedAt = game._finishedAt;
      if (!finishedAt || now - finishedAt < ttlMs) continue;
      void this.clearTrixGame(tableId, { archiveReason: "game_complete" });
      evicted += 1;
    }
    return evicted;
  }

  startTrixTtlSweep(intervalMs = 60_000) {
    if (this._trixTtlSweepInterval) return;
    this._trixTtlSweepInterval = setInterval(() => {
      try {
        this.evictExpiredTrixGames();
      } catch (_) {
        // ignore sweep errors
      }
    }, intervalMs);
    if (typeof this._trixTtlSweepInterval.unref === "function") {
      this._trixTtlSweepInterval.unref();
    }
  }

  stopTrixTtlSweep() {
    if (this._trixTtlSweepInterval) {
      clearInterval(this._trixTtlSweepInterval);
      this._trixTtlSweepInterval = null;
    }
  }

  /** @deprecated use tryClearTrixGameIfReady */
  clearTrixGameIfAllHumansGone(mongoTableId) {
    return this.tryClearTrixGameIfReady(mongoTableId);
  }

  createRoom(gameType) {
    this.roomCounter++;
    const roomId = `room_${this.roomCounter}_${gameType}`;
    const room = new Room(roomId, gameType);
    this.rooms.set(roomId, room);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  getRoomByUser(userId) {
    const roomId = this.userToRoom.get(String(userId));
    return roomId ? this.rooms.get(roomId) : null;
  }

  addUserToRoom(userId, roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const game = room.gameInstance || room.createGame();
    if (!game) return null;
    const seatIndex = game.addPlayer(userId, socketId);
    if (seatIndex < 0) return null;
    this.userToRoom.set(String(userId), roomId);
    return { room, game, seatIndex };
  }

  removeUserFromRoom(userId) {
    const roomId = this.userToRoom.get(String(userId));
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const game = room.gameInstance;
    if (game) game.removePlayer(userId);
    this.userToRoom.delete(String(userId));
    const playerCount = game ? game.players.length : 0;
    if (playerCount === 0) {
      this.rooms.delete(roomId);
      return { room, removed: true, roomDeleted: true };
    }
    return { room, game, removed: true };
  }

  startGame(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameInstance) return false;
    const game = room.gameInstance;
    const started = game.startGame();
    if (started) room.state = "in_progress";
    return started;
  }

  getGameState(roomId, forUserId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameInstance) return null;
    const game = room.gameInstance;
    const playerIndex = game.getPlayerIndex(forUserId);
    if (playerIndex < 0) return null;
    return game.getGameState(playerIndex);
  }

  deleteRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || !room.gameInstance) return;
    room.gameInstance.players.forEach((p) => this.userToRoom.delete(String(p.userId)));
    this.rooms.delete(roomId);
  }
}

module.exports = new RoomManager();
