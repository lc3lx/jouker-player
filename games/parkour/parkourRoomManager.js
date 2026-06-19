/**
 * In-memory registry for active Parkour races (mirrors Trix/Tarneeb41 table maps).
 */
const ParkourGame = require("./ParkourGame");
const { ParkourRoom } = require("./ParkourRoom");
const ParkourRace = require("../../models/parkourRaceModel");
const ParkourCheckpoint = require("../../models/parkourCheckpointModel");
const logger = require("../../utils/logger");

class ParkourRoomManager {
  constructor() {
    /** @type {Map<string, import('./ParkourRoom').ParkourRoom>} */
    this.rooms = new Map();
    /** @type {Map<string, string>} userId -> raceId */
    this.userToRace = new Map();
    /** @type {Map<string, string>} raceMongoId -> raceId */
    this.mongoIdToRace = new Map();
  }

  async loadRoom(raceId) {
    const key = String(raceId);
    if (this.rooms.has(key)) return this.rooms.get(key);

    const raceDoc = await ParkourRace.findOne({ raceId: key }).lean();
    if (!raceDoc) return null;

    const track = await ParkourCheckpoint.findOne({ trackId: raceDoc.trackId, isActive: true }).lean();
    if (!track) return null;

    const game = new ParkourGame(raceDoc, track);
    const room = new ParkourRoom(game);
    this.rooms.set(key, room);
    this.mongoIdToRace.set(String(raceDoc._id), key);
    for (const p of game.players) {
      this.userToRace.set(String(p.userId), key);
    }
    return room;
  }

  registerRoom(raceId, room) {
    const key = String(raceId);
    this.rooms.set(key, room);
    if (room.game?.mongoId) {
      this.mongoIdToRace.set(String(room.game.mongoId), key);
    }
    for (const p of room.game.players) {
      this.userToRace.set(String(p.userId), key);
    }
  }

  getRoom(raceId) {
    return this.rooms.get(String(raceId)) || null;
  }

  getRaceIdForUser(userId) {
    return this.userToRace.get(String(userId)) || null;
  }

  bindUser(userId, raceId, socketId) {
    this.userToRace.set(String(userId), String(raceId));
    const room = this.getRoom(raceId);
    if (room) {
      const p = room.game.getPlayer(userId);
      if (p) p.socketId = socketId;
    }
  }

  unbindUser(userId) {
    this.userToRace.delete(String(userId));
  }

  removeRoom(raceId) {
    const key = String(raceId);
    const room = this.rooms.get(key);
    if (room) {
      room.clearTimers();
      if (room.game?.mongoId) {
        this.mongoIdToRace.delete(String(room.game.mongoId));
      }
      for (const p of room.game.players) {
        this.userToRace.delete(String(p.userId));
      }
    }
    this.rooms.delete(key);
  }

  /** Restore all active races from Mongo after server restart. */
  async restoreActiveRaces() {
    const activeStates = ["waiting", "countdown", "starting", "playing", "finished", "settlement_pending"];
    const races = await ParkourRace.find({ state: { $in: activeStates } }).lean();
    let restored = 0;
    for (const raceDoc of races) {
      try {
        const track = await ParkourCheckpoint.findOne({ trackId: raceDoc.trackId }).lean();
        if (!track) continue;
        const game = new ParkourGame(raceDoc, track);
        const room = new ParkourRoom(game);
        this.registerRoom(raceDoc.raceId, room);
        restored += 1;
      } catch (err) {
        logger.error("parkour_restore_race_failed", {
          raceId: raceDoc.raceId,
          reason: err?.message,
        });
      }
    }
    return restored;
  }

  listActiveRooms() {
    return [...this.rooms.values()];
  }
}

module.exports = new ParkourRoomManager();
