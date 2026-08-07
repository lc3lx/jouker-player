const Table = require("../models/tableModel");
const mongoose = require("mongoose");
const {
  withMongoTransaction,
  transferToLocked,
  releaseTableSeatToBalance,
} = require("./walletLedgerService");
const { normalizeCapacity } = require("../utils/pokerTableStatus");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");

function queueEntryUserId(entry) {
  return String(entry?.user?._id || entry?.user || "");
}

/**
 * A wait-list entry and its locked buy-in must commit/abort together.  Redis
 * can still be used for invalidatable read caches, but it is intentionally not
 * a queue source here: Mongo transaction retries cannot safely replay a
 * destructive Redis operation.
 */
async function enqueuePlayer({ session, userId, playerId, buyIn, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.gameType !== "poker") throw new Error("NOT_POKER");

  const cap = normalizeCapacity(tableTx.capacity);
  if (tableTx.seats.length < cap) throw new Error("SEAT_AVAILABLE");
  if (tableTx.seats.some((s) => String(s.user) === String(userId))) {
    throw new Error("ALREADY_SEATED");
  }

  tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
  if (tableTx.waitingQueue.some((q) => queueEntryUserId(q) === String(userId))) {
    throw new Error("ALREADY_QUEUED");
  }

  await transferToLocked({
    session,
    userId,
    amount: buyIn,
    tableId: tableTx._id,
    meta: { reason: "join_queue", tableNumber: tableTx.tableNumber },
  });

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

/** Seat the first durable queued entry as part of the caller's Mongo transaction. */
async function seatNextFromQueue({ session, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx || tableTx.gameType !== "poker") return null;

  const cap = normalizeCapacity(tableTx.capacity);
  if (tableTx.seats.length >= cap) return null;
  tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
  const row = tableTx.waitingQueue.shift();
  if (!row) return null;

  const uid = queueEntryUserId(row);
  const buyIn = Number(row.buyIn || tableTx.minBuyIn);
  if (!uid) {
    await tableTx.save({ session });
    return seatNextFromQueue({ session, tableId });
  }
  if (tableTx.seats.some((s) => String(s.user) === uid)) {
    await tableTx.save({ session });
    return seatNextFromQueue({ session, tableId });
  }

  const {
    nextFreeSeatPosition,
    POKER_OPPOSITE_DEALER_SEAT,
  } = require("./pokerTableAllocationService");
  const seatPosition =
    nextFreeSeatPosition(tableTx.seats, cap) ?? POKER_OPPOSITE_DEALER_SEAT;

  tableTx.seats.push({
    user: uid,
    player: row.player,
    chips: buyIn,
    seatPosition,
  });
  await tableTx.save({ session });
  // Informational only. A transaction retry may emit this more than once; the
  // lobby reloads authoritative data and never treats it as a money event.
  emitTablesUpdated({ gameType: "poker", reason: "queue_seated", tableId: String(tableId), userId: uid });
  return uid;
}

/** Remove a queue entry and release the same locked amount atomically. */
async function dequeuePlayer({ session, userId, tableId }) {
  const tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");

  // Keep this check in the same transaction as the queue removal. A queue
  // promotion writes this document too, so a transaction retry observes the
  // durable state and cannot refund a player who has just been seated.
  if (tableTx.seats.some((seat) => String(seat.user) === String(userId))) {
    throw new Error("ALREADY_SEATED");
  }

  tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];
  const idx = tableTx.waitingQueue.findIndex((q) => queueEntryUserId(q) === String(userId));
  if (idx === -1) throw new Error("NOT_IN_QUEUE");
  const row = tableTx.waitingQueue.splice(idx, 1)[0];
  const buyIn = Number(row.buyIn || 0);
  await tableTx.save({ session });

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
  const table = await Table.findById(tableId).select("waitingQueue");
  if (!table) return -1;
  const q = Array.isArray(table.waitingQueue) ? table.waitingQueue : [];
  const idx = q.findIndex((e) => queueEntryUserId(e) === String(userId));
  return idx >= 0 ? idx + 1 : -1;
}

async function getWaitingQueueSize(tableId) {
  const table = await Table.findById(tableId).select("waitingQueue").lean();
  return Array.isArray(table?.waitingQueue) ? table.waitingQueue.length : 0;
}

async function findUserQueuedPokerTable(userId) {
  const table = await Table.findOne({ gameType: "poker", "waitingQueue.user": userId }).select("_id");
  return table ? String(table._id) : null;
}

/**
 * One-way deployment migration for the former Redis-only poker wait-list.
 * Wallet funds were already locked at enqueue, so this moves metadata only;
 * the Redis row is removed only after the Mongo transaction commits.
 */
async function migrateLegacyQueueForTable(tableId) {
  const legacyQueue = require("../utils/redis/pokerQueueRedis");
  if (!legacyQueue.isEnabled()) return { migrated: 0, remaining: 0 };
  const legacyRows = await legacyQueue.listQueueEntries(tableId);
  if (!legacyRows.length) return { migrated: 0, remaining: 0 };

  let migrated = 0;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tableId).session(session);
    if (!table || table.gameType !== "poker") return;
    table.waitingQueue = Array.isArray(table.waitingQueue) ? table.waitingQueue : [];
    const known = new Set([
      ...table.seats.map((seat) => String(seat.user)),
      ...table.waitingQueue.map(queueEntryUserId),
    ]);
    for (const row of legacyRows) {
      const userId = String(row?.userId || "");
      if (!userId || known.has(userId)) continue;
      table.waitingQueue.push({
        user: userId,
        player: mongoose.isValidObjectId(row.playerId) ? row.playerId : undefined,
        buyIn: Math.max(0, Number(row.buyIn) || 0),
        queuedAt: Number.isFinite(Number(row.queuedAt)) ? new Date(Number(row.queuedAt)) : new Date(),
      });
      known.add(userId);
      migrated += 1;
    }
    if (migrated > 0) await table.save({ session });
  });

  const table = await Table.findById(tableId).select("seats waitingQueue").lean();
  const persisted = new Set([
    ...(table?.seats || []).map((seat) => String(seat.user)),
    ...(table?.waitingQueue || []).map(queueEntryUserId),
  ]);
  let removed = 0;
  for (const row of legacyRows) {
    if (persisted.has(String(row?.userId || ""))) {
      await legacyQueue.removeFromQueue(tableId, row.userId);
      removed += 1;
    }
  }
  return { migrated, remaining: Math.max(0, legacyRows.length - removed) };
}

async function migrateLegacyPokerQueues() {
  const legacyQueue = require("../utils/redis/pokerQueueRedis");
  if (!legacyQueue.isEnabled()) return { tables: 0, migrated: 0, remaining: 0 };
  let tables = 0;
  let migrated = 0;
  let remaining = 0;
  const cursor = Table.find({ gameType: "poker" }).select("_id").lean().cursor();
  for await (const table of cursor) {
    const result = await migrateLegacyQueueForTable(table._id);
    tables += 1;
    migrated += result.migrated;
    remaining += result.remaining;
  }
  return { tables, migrated, remaining };
}

module.exports = {
  enqueuePlayer,
  seatNextFromQueue,
  dequeuePlayer,
  getQueuePosition,
  getWaitingQueueSize,
  findUserQueuedPokerTable,
  migrateLegacyQueueForTable,
  migrateLegacyPokerQueues,
  queueEntryUserId,
};
