/**
 * WaitingQueueService — unified queue API for card games (trix/tarneeb41).
 *
 * Card games: use the Mongo waitingQueue subdoc (already on tableModel).
 *   No wallet lock at enqueue time — funds are locked when the player actually joins.
 *
 * Poker: this service exposes read-only helpers (getPosition, getSize) that
 *   delegate to pokerWaitingQueueService. The poker enqueue/dequeue write paths
 *   remain in joinPokerWithRetry / leaveTable as-is (session-based transactions).
 */
const Table = require("../models/tableModel");
const {
  getQueuePosition: pokerGetPosition,
  getWaitingQueueSize: pokerGetSize,
} = require("./pokerWaitingQueueService");

// ─── Card game helpers ────────────────────────────────────────────────────

async function enqueueCard({ userId, playerId, tableId, buyIn }) {
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) throw new Error("TABLE_NOT_FOUND");

  const already = table.waitingQueue.find((e) => String(e.user) === String(userId));
  if (already) throw new Error("ALREADY_QUEUED");

  table.waitingQueue.push({ user: userId, player: playerId, buyIn });
  await table.save();

  return table.waitingQueue.findIndex((e) => String(e.user) === String(userId)) + 1;
}

async function dequeueNextCard(tableId) {
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table || table.waitingQueue.length === 0) return null;

  const entry = table.waitingQueue[0];
  table.waitingQueue.splice(0, 1);
  await table.save();

  return { userId: String(entry.user), buyIn: entry.buyIn, tableId: String(tableId) };
}

async function getPositionCard(userId, tableId) {
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) return -1;
  const idx = table.waitingQueue.findIndex((e) => String(e.user) === String(userId));
  return idx === -1 ? -1 : idx + 1;
}

async function cancelCard(userId, tableId) {
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) return false;
  const before = table.waitingQueue.length;
  table.waitingQueue = table.waitingQueue.filter((e) => String(e.user) !== String(userId));
  if (table.waitingQueue.length === before) return false;
  await table.save();
  return true;
}

async function getSizeCard(tableId) {
  const table = await Table.findById(tableId).select("waitingQueue");
  return table ? table.waitingQueue.length : 0;
}

// ─── Unified API ─────────────────────────────────────────────────────────

/**
 * Add a card-game player to the waiting queue for a full static table.
 * Throws ALREADY_QUEUED if already in queue.
 * Returns 1-based queue position.
 */
async function enqueue({ userId, playerId, tableId, gameType, buyIn }) {
  if (gameType === "poker") {
    throw new Error("Use joinPokerWithRetry for poker queuing");
  }
  return enqueueCard({ userId, playerId, tableId, buyIn });
}

/**
 * Pop the next card-game player from the waiting queue.
 * Returns { userId, buyIn, tableId } or null if queue empty.
 * Caller is responsible for emitting queue_seat_available to their socket.
 */
async function dequeueNext(tableId, gameType) {
  if (gameType === "poker") {
    throw new Error("Use seatNextFromQueue for poker dequeue");
  }
  return dequeueNextCard(tableId);
}

/**
 * Get 1-based queue position for a user.
 * Returns -1 if not queued.
 */
async function getPosition(userId, tableId, gameType) {
  if (gameType === "poker") {
    return pokerGetPosition(tableId, userId);
  }
  return getPositionCard(userId, tableId);
}

/**
 * Cancel a card-game queue entry. No wallet reversal needed (no locked funds at queue time).
 */
async function cancel(userId, tableId, gameType) {
  if (gameType === "poker") {
    throw new Error("Use dequeuePlayer for poker cancel (requires session)");
  }
  return cancelCard(userId, tableId);
}

/**
 * Get total queue length.
 */
async function getSize(tableId, gameType) {
  if (gameType === "poker") {
    return pokerGetSize(tableId);
  }
  return getSizeCard(tableId);
}

module.exports = {
  enqueue,
  dequeueNext,
  getPosition,
  cancel,
  getSize,
};
