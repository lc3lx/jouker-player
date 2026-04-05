/**
 * MatchMaker - collects players by gameType and creates rooms when full.
 * Tarneeb = 4 players
 */
const roomManager = require("../rooms/roomManager");

const GAME_REQUIREMENTS = {
  tarneeb: 4,
  trix: 1, // Trix can start with 1 human, the rest are bots
  tarneeb41: 4,
};

class MatchMaker {
  constructor() {
    this.queues = new Map(); // gameType -> [{ userId, socketId }]
  }

  /** Add player to queue. Returns room + seatIndex when room is created, or null if waiting */
  enqueue(gameType, userId, socketId) {
    if (!GAME_REQUIREMENTS[gameType]) return { error: "unknown_game" };
    const required = GAME_REQUIREMENTS[gameType];
    let queue = this.queues.get(gameType);
    if (!queue) {
      queue = [];
      this.queues.set(gameType, queue);
    }
    if (queue.some((p) => String(p.userId) === String(userId))) {
      return { error: "already_in_queue" };
    }
    queue.push({ userId, socketId });
    if (queue.length >= required) {
      const players = queue.splice(0, required);
      this.queues.delete(gameType);
      const room = roomManager.createRoom(gameType);
      const results = [];
      for (const p of players) {
        const r = roomManager.addUserToRoom(p.userId, room.roomId, p.socketId);
        if (r) results.push({ userId: p.userId, socketId: p.socketId, roomId: room.roomId, seatIndex: r.seatIndex });
      }
      roomManager.startGame(room.roomId);
      return { roomCreated: true, roomId: room.roomId, players: results };
    }
    return { waiting: true, queueSize: queue.length, required };
  }

  /** Remove player from queue */
  dequeue(gameType, userId) {
    const queue = this.queues.get(gameType);
    if (!queue) return;
    const idx = queue.findIndex((p) => String(p.userId) === String(userId));
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.queues.delete(gameType);
  }

  /** Used when table-based games dequeue on socket join */
  dequeueAny(userId) {
    this.dequeue("tarneeb", userId);
    this.dequeue("trix", userId);
    this.dequeue("tarneeb41", userId);
  }

  getQueueSize(gameType) {
    const q = this.queues.get(gameType);
    return q ? q.length : 0;
  }
}

module.exports = new MatchMaker();
