/**
 * RoomManager - manages game rooms.
 * Each room: gameType, players, gameInstance, state
 */
const TarneebGame = require("../games/tarneeb/TarneebGame");
const TrixGame = require("../games/trix/TrixGame");

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
    return { tableId: tid, game };
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
    return { tableId: tid, game };
  }

  clearTrixGameIfAllHumansGone(mongoTableId) {
    const game = this.getTrixGameForTable(mongoTableId);
    if (!game) return;
    const humans = game.players.filter((p) => !p.isBot);
    const anyConnected = humans.some((p) => p.socketId);
    if (!anyConnected && game.botInterval) {
      clearInterval(game.botInterval);
      game.botInterval = null;
    }
    const humansLeft = this.countHumansAtTrixTable(mongoTableId);
    if (humansLeft === 0 && !anyConnected) {
      this.trixGamesByTableId.delete(String(mongoTableId));
    }
  }

  countHumansAtTrixTable(mongoTableId) {
    let n = 0;
    for (const [uid, tid] of this.userToTrixTableId.entries()) {
      if (tid === String(mongoTableId)) n++;
    }
    return n;
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
