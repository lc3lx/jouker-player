const Table = require("../models/tableModel");
const { withMongoTransaction, transferToLocked } = require("./walletLedgerService");
const { getTableGameDebugSnapshot } = require("../sockets/tableGame");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const {
  POKER_CAPACITY,
  derivePokerTableStatus,
  normalizeCapacity,
} = require("../utils/pokerTableStatus");
const { enqueuePlayer } = require("./pokerWaitingQueueService");
const {
  assertNoCollusionAtPublicTable,
  registerSeatPresence,
} = require("./pokerCollusionGuard");
const { markTableActivity } = require("./pokerTableGcService");

function deriveBlindsFromBuyIn(buyIn) {
  const bigBlind = Math.max(100, Math.floor(Number(buyIn || 0) / 50));
  const smallBlind = Math.max(50, Math.floor(bigBlind / 2));
  return { smallBlind, bigBlind };
}

/** Serialize find-or-create per tier+buyIn to avoid duplicate empty tables under burst load. */
const allocationChains = new Map();

function withPokerAllocationLock(tier, buyIn, fn) {
  const key = `${tier}:${buyIn}`;
  const prev = allocationChains.get(key) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (allocationChains.get(key) === run) allocationChains.delete(key);
    });
  allocationChains.set(key, run);
  return run;
}

function isHandActiveOnTable(tableId) {
  const live = getTableGameDebugSnapshot(String(tableId));
  return !!(live && live.running && live.round && String(live.round) !== "idle");
}

/**
 * Find first joinable poker table or create a new one.
 * Fills lowest tableNumber first for occupancy balance.
 */
async function findAvailablePokerTable(tier, buyIn, session) {
  const cap = POKER_CAPACITY;
  const q = {
    gameType: "poker",
    tier,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    status: { $nin: ["full", "closed", "archived"] },
    $expr: { $lt: [{ $size: "$seats" }, cap] },
  };
  let query = Table.findOne(q).sort({ tableNumber: 1 });
  if (session) query = query.session(session);
  let table = await query;
  if (table) return table;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const maxDoc = await Table.findOne({ gameType: "poker", tier, minBuyIn: buyIn, maxBuyIn: buyIn })
      .sort({ tableNumber: -1 })
      .select("tableNumber")
      .session(session || null);
    const tableNumber = (maxDoc?.tableNumber || 0) + 1 + attempt;
    const { smallBlind, bigBlind } = deriveBlindsFromBuyIn(buyIn);
    const createOpts = session ? { session } : {};
    try {
      table = await Table.create(
        [
          {
            gameType: "poker",
            tier,
            tableNumber,
            smallBlind,
            bigBlind,
            minBuyIn: buyIn,
            maxBuyIn: buyIn,
            capacity: cap,
            isPrivate: false,
            status: "waiting",
            seats: [],
            waitingQueue: [],
          },
        ],
        createOpts
      );
      const created = Array.isArray(table) ? table[0] : table;
      emitTablesUpdated({
        gameType: "poker",
        reason: "table_created",
        tableId: String(created._id),
        tier,
        buyIn,
      });
      return created;
    } catch (err) {
      if (err && err.code === 11000 && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("TABLE_CREATE_FAILED");
}

function liveSnapshotForTable(tableId) {
  return getTableGameDebugSnapshot(String(tableId));
}

function statusAfterSeatChange(tableDoc, seatCount) {
  const live = liveSnapshotForTable(tableDoc._id);
  const cap = normalizeCapacity(tableDoc.capacity);
  return derivePokerTableStatus({
    mongoSeatCount: seatCount,
    capacity: cap,
    running: live?.running,
    round: live?.round,
  });
}

/**
 * Atomic seat + wallet lock inside caller's Mongo transaction.
 * @param {{ preferQueue?: boolean }} opts — when true and table full, FIFO queue on that table.
 */
async function executePokerJoinTransaction({
  userId,
  playerId,
  buyIn,
  tableId,
  session,
  preferQueue = false,
  clientIp = null,
  deviceId = null,
}) {
  let tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.gameType !== "poker") throw new Error("NOT_POKER");

  const cap = normalizeCapacity(tableTx.capacity);
  tableTx.capacity = cap;
  tableTx.waitingQueue = Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : [];

  const seated = tableTx.seats.find((s) => String(s.user) === String(userId));
  if (seated) throw new Error("ALREADY_SEATED");

  const inQueue = tableTx.waitingQueue.find((q) => String(q.user) === String(userId));
  if (inQueue) throw new Error("ALREADY_QUEUED");

  if (buyIn < tableTx.minBuyIn || buyIn > tableTx.maxBuyIn) {
    throw new Error("INVALID_BUYIN");
  }

  if (tableTx.seats.length >= cap) {
    if (preferQueue) {
      return enqueuePlayer({ session, userId, playerId, buyIn, tableId: tableTx._id });
    }
    tableTx = await findAvailablePokerTable(tableTx.tier, buyIn, session);
  }

  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.status === "closed") throw new Error("TABLE_CLOSED");
  if (tableTx.seats.length >= cap) {
    if (preferQueue) {
      return enqueuePlayer({ session, userId, playerId, buyIn, tableId: tableTx._id });
    }
    throw new Error("TABLE_FULL");
  }

  await assertNoCollusionAtPublicTable({
    tableId: tableTx._id,
    userId,
    ip: clientIp,
    deviceId,
    session,
  });

  await transferToLocked({
    session,
    userId,
    amount: buyIn,
    tableId: tableTx._id,
    meta: { reason: "join_table", tableNumber: tableTx.tableNumber },
  });

  tableTx.seats.push({ user: userId, player: playerId, chips: buyIn });
  if (tableTx.seats.length > cap) throw new Error("TABLE_FULL");

  tableTx.status = statusAfterSeatChange(tableTx, tableTx.seats.length);
  await tableTx.save({ session });
  markTableActivity(String(tableTx._id));
  return {
    tableId: String(tableTx._id),
    queued: false,
    midHandJoin: isHandActiveOnTable(tableTx._id),
  };
}

async function joinPokerWithRetry({
  userId,
  playerId,
  buyIn,
  initialTableId,
  tier,
  preferQueue = false,
  clientIp = null,
  deviceId = null,
}) {
  const maxAttempts = 8;
  let targetId = String(initialTableId);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      let result = { tableId: targetId };
      await withMongoTransaction(async (session) => {
        result = await executePokerJoinTransaction({
          userId,
          playerId,
          buyIn,
          tableId: targetId,
          session,
          preferQueue: preferQueue && attempt === 0,
          clientIp,
          deviceId,
        });
      });
      if (!result.queued) {
        await registerSeatPresence({
          tableId: result.tableId,
          userId,
          ip: clientIp,
          deviceId,
        });
      }
      return result;
    } catch (err) {
      lastError = err;
      if (err.message === "ALREADY_QUEUED" || err.queued) throw err;
      const retryable =
        err.message === "TABLE_FULL" ||
        err.message === "TABLE_CLOSED" ||
        err.message === "TABLE_NOT_FOUND";
      if (retryable && attempt < maxAttempts - 1) {
        const next = await withPokerAllocationLock(tier, buyIn, () =>
          findAvailablePokerTable(tier, buyIn)
        );
        targetId = String(next._id);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("TABLE_FULL");
}

async function allocateAndJoinPoker({ userId, playerId, buyIn, tier, preferredTableId, preferQueue }) {
  let targetId = preferredTableId ? String(preferredTableId) : null;

  if (!targetId) {
    const table = await withPokerAllocationLock(tier, buyIn, () =>
      findAvailablePokerTable(tier, buyIn)
    );
    targetId = String(table._id);
  }

  return joinPokerWithRetry({
    userId,
    playerId,
    buyIn,
    initialTableId: targetId,
    tier,
    preferQueue: !!preferQueue,
  });
}

async function syncPokerTableStatusById(tableId) {
  const table = await Table.findById(tableId).select("gameType seats capacity status waitingQueue");
  if (!table || table.gameType !== "poker") return null;
  const cap = normalizeCapacity(table.capacity);
  const next = statusAfterSeatChange(table, table.seats.length);
  if (table.status !== next) {
    table.status = next;
    table.capacity = cap;
    await table.save();
  }
  return next;
}

module.exports = {
  findAvailablePokerTable,
  executePokerJoinTransaction,
  joinPokerWithRetry,
  allocateAndJoinPoker,
  syncPokerTableStatusById,
  withPokerAllocationLock,
  deriveBlindsFromBuyIn,
  statusAfterSeatChange,
  isHandActiveOnTable,
};
