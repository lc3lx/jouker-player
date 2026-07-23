const Table = require("../models/tableModel");
const { transferToLocked, releaseTableSeatToBalance } = require("./walletLedgerService");
const { normalizeCapacity } = require("../utils/pokerTableStatus");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const pokerQueueRedis = require("../utils/redis/pokerQueueRedis");

function queueEntryUserId(entry) {
  return String(entry?.user?._id || entry?.user || "");
}

/**
 * FIFO enqueue when table has no open seat.
 * Redis ZSET when available; Mongo array fallback for single-node / dev.
 */
async function enqueuePlayer({ session, userId, playerId, buyIn, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.gameType !== "poker") throw new Error("NOT_POKER");

  const cap = normalizeCapacity(tableTx.capacity);
  if (tableTx.seats.length < cap) throw new Error("SEAT_AVAILABLE");

  const seated = tableTx.seats.find((s) => String(s.user) === String(userId));
  if (seated) throw new Error("ALREADY_SEATED");

  if (pokerQueueRedis.isEnabled()) {
    const already = await pokerQueueRedis.isUserQueued(tableId, userId);
    if (already) throw new Error("ALREADY_QUEUED");
  } else {
    tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
    const inQueue = tableTx.waitingQueue.find((q) => queueEntryUserId(q) === String(userId));
    if (inQueue) throw new Error("ALREADY_QUEUED");
  }

  await transferToLocked({
    session,
    userId,
    amount: buyIn,
    tableId: tableTx._id,
    meta: { reason: "join_queue", tableNumber: tableTx.tableNumber },
  });

  if (pokerQueueRedis.isEnabled()) {
    const r = await pokerQueueRedis.enqueue({ tableId: tableTx._id, userId, playerId, buyIn });
    return {
      tableId: String(tableTx._id),
      queued: true,
      queuePosition: r.position,
    };
  }

  tableTx.waitingQueue.push({
    user: userId,
    player: playerId,
    buyIn,
    queuedAt: new Date(),
  });
  await tableTx.save({ session });
  return {
    tableId: String(tableTx._id),
    queued: true,
    queuePosition: tableTx.waitingQueue.length,
  };
}

/**
 * Seat first queued player after a leave. Returns seated userId or null.
 */
async function seatNextFromQueue({ session, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx || tableTx.gameType !== "poker") return null;

  const cap = normalizeCapacity(tableTx.capacity);
  if (tableTx.seats.length >= cap) return null;

  let next = null;
  if (pokerQueueRedis.isEnabled()) {
    next = await pokerQueueRedis.dequeueNext(tableId);
  } else {
    tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
    if (tableTx.waitingQueue.length === 0) return null;
    const row = tableTx.waitingQueue.shift();
    if (!row) return null;
    next = {
      userId: queueEntryUserId(row),
      playerId: row.player,
      buyIn: Number(row.buyIn || tableTx.minBuyIn),
    };
  }

  if (!next) return null;

  const uid = String(next.userId);
  const buyIn = Number(next.buyIn || tableTx.minBuyIn);
  const already = tableTx.seats.find((s) => String(s.user) === uid);
  if (already) {
    if (!pokerQueueRedis.isEnabled()) {
      await tableTx.save({ session });
    }
    return seatNextFromQueue({ session, tableId });
  }

  // Lazy require: pokerTableAllocationService requires this module (cycle-safe).
  const {
    nextFreeSeatPosition,
    POKER_OPPOSITE_DEALER_SEAT,
  } = require("./pokerTableAllocationService");
  const seatPosition =
    nextFreeSeatPosition(tableTx.seats, cap) ?? POKER_OPPOSITE_DEALER_SEAT;

  tableTx.seats.push({
    user: next.userId,
    player: next.playerId,
    chips: buyIn,
    seatPosition,
  });
  await tableTx.save({ session });
  emitTablesUpdated({ gameType: "poker", reason: "queue_seated", tableId: String(tableId), userId: uid });
  return uid;
}

/**
 * Remove user from queue and refund locked buy-in.
 */
async function dequeuePlayer({ session, userId, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");

  let buyIn = 0;

  if (pokerQueueRedis.isEnabled()) {
    const entry = await pokerQueueRedis.getQueueEntry(tableId, userId);
    if (!entry) throw new Error("NOT_IN_QUEUE");
    buyIn = Number(entry.buyIn || tableTx.minBuyIn || 0);
    const removed = await pokerQueueRedis.removeFromQueue(tableId, userId);
    if (!removed) throw new Error("NOT_IN_QUEUE");
  } else {
    tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
    const idx = tableTx.waitingQueue.findIndex((q) => queueEntryUserId(q) === String(userId));
    if (idx === -1) throw new Error("NOT_IN_QUEUE");
    const row = tableTx.waitingQueue.splice(idx, 1)[0];
    buyIn = Number(row.buyIn || 0);
    await tableTx.save({ session });
  }

  if (buyIn > 0) {
    await releaseTableSeatToBalance({
      session,
      userId,
      seatChips: buyIn,
      tableId: tableTx._id,
      meta: { reason: "leave_queue_refund", tableNumber: tableTx.tableNumber },
    });
  }
  return true;
}

async function getQueuePosition(tableId, userId) {
  if (pokerQueueRedis.isEnabled()) {
    return pokerQueueRedis.getPosition(tableId, userId);
  }
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) return -1;
  const q = Array.isArray(table.waitingQueue) ? table.waitingQueue : [];
  const idx = q.findIndex((e) => queueEntryUserId(e) === String(userId));
  return idx >= 0 ? idx + 1 : -1;
}

async function getWaitingQueueSize(tableId) {
  if (pokerQueueRedis.isEnabled()) {
    return pokerQueueRedis.getQueueLength(tableId);
  }
  const table = await Table.findById(tableId).select("waitingQueue").lean();
  return Array.isArray(table?.waitingQueue) ? table.waitingQueue.length : 0;
}

/** Which poker table (if any) has this user queued right now — Redis-aware. */
async function findUserQueuedPokerTable(userId) {
  if (pokerQueueRedis.isEnabled()) {
    const tableId = await pokerQueueRedis.getQueuedTableForUser(userId);
    return tableId ? String(tableId) : null;
  }
  const table = await Table.findOne({ gameType: "poker", "waitingQueue.user": userId }).select("_id");
  return table ? String(table._id) : null;
}

module.exports = {
  enqueuePlayer,
  seatNextFromQueue,
  dequeuePlayer,
  getQueuePosition,
  getWaitingQueueSize,
  findUserQueuedPokerTable,
  queueEntryUserId,
};
