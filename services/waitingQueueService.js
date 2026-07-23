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

/**
 * Atomic $push guarded by a "not already queued" filter — two concurrent
 * enqueues on the same table can no longer race a read-modify-write
 * table.save() and silently drop one entry (last-write-wins on the array).
 */
async function enqueueCard({ userId, playerId, tableId, buyIn }) {
  const updated = await Table.findOneAndUpdate(
    { _id: tableId, "waitingQueue.user": { $ne: userId } },
    { $push: { waitingQueue: { user: userId, player: playerId, buyIn } } },
    { new: true, select: "waitingQueue" }
  );
  if (!updated) {
    const exists = await Table.exists({ _id: tableId });
    if (!exists) throw new Error("TABLE_NOT_FOUND");
    throw new Error("ALREADY_QUEUED");
  }
  return updated.waitingQueue.findIndex((e) => String(e.user) === String(userId)) + 1;
}

/**
 * Atomic FIFO pop: findOneAndUpdate with new:false returns the pre-update
 * document so we can read the entry that $pop just removed, in one op.
 */
async function dequeueNextCard(tableId) {
  const before = await Table.findOneAndUpdate(
    { _id: tableId, "waitingQueue.0": { $exists: true } },
    { $pop: { waitingQueue: -1 } },
    { new: false, select: "waitingQueue" }
  );
  if (!before || !Array.isArray(before.waitingQueue) || before.waitingQueue.length === 0) {
    return null;
  }
  const entry = before.waitingQueue[0];
  return { userId: String(entry.user), buyIn: entry.buyIn, tableId: String(tableId) };
}

async function getPositionCard(userId, tableId) {
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) return -1;
  const idx = table.waitingQueue.findIndex((e) => String(e.user) === String(userId));
  return idx === -1 ? -1 : idx + 1;
}

async function cancelCard(userId, tableId) {
  const updated = await Table.findOneAndUpdate(
    { _id: tableId, "waitingQueue.user": userId },
    { $pull: { waitingQueue: { user: userId } } },
    { new: true, select: "_id" }
  );
  return !!updated;
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
