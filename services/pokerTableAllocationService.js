const Table = require("../models/tableModel");
const { withMongoTransaction, transferToLocked } = require("./walletLedgerService");
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
const tableFactory = require("./tableFactory");

function getTableGameBridge() {
  return require("../sockets/pokerTableGameBridge");
}

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
  const snap = getTableGameBridge().getTableGameDebugSnapshot(String(tableId));
  return !!(snap && snap.running && snap.round && String(snap.round) !== "idle");
}

/**
 * Find first joinable poker table or create a new one.
 * Fills lowest tableNumber first for occupancy balance.
 *
 * [opts.capacity] pins the table size. A stake now has both a nine-handed and a
 * five-handed table, so matching on stake alone would drop a player asking for
 * five-max into the nine-max room — and spawn the overflow at the wrong size.
 * [opts.botsEnabled] carries the source table's bot policy onto that overflow.
 */
async function findAvailablePokerTable(tier, buyIn, session, opts = {}) {
  const cap = normalizeCapacity(opts.capacity ?? POKER_CAPACITY);
  const excludeIds = (opts.excludeIds || []).map(String).filter(Boolean);
  const q = {
    gameType: "poker",
    tier,
    capacity: cap,
    minBuyIn: opts.minBuyIn ?? buyIn,
    maxBuyIn: opts.maxBuyIn ?? buyIn,
    isPrivate: { $ne: true },
    owner: null,
    tableKind: { $in: ["static", "dynamic"] },
    status: { $nin: ["full", "closed", "archived"] },
    $expr: { $lt: [{ $size: "$seats" }, cap] },
  };
  if (opts.smallBlind != null) q.smallBlind = opts.smallBlind;
  if (opts.bigBlind != null) q.bigBlind = opts.bigBlind;
  if (excludeIds.length > 0) q._id = { $nin: excludeIds };
  let query = Table.findOne(q).sort({ tableNumber: 1 });
  if (session) query = query.session(session);
  let table = await query;
  if (table) return table;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const maxDoc = await Table.findOne({ gameType: "poker", tier })
      .sort({ tableNumber: -1 })
      .select("tableNumber")
      .session(session || null);
    const tableNumber = (maxDoc?.tableNumber || 0) + 1 + attempt;
    const { smallBlind, bigBlind } = deriveBlindsFromBuyIn(buyIn);
    try {
      // Overflow tables beyond the fixed static tables MUST go through
      // tableFactory (the single Table.create() entrypoint) so they're
      // correctly marked tableKind:"dynamic" — otherwise they default to
      // "static" and pokerTableGcService refuses to ever GC them.
      const created = await tableFactory.createDynamicTable({
        gameType: "poker",
        tier,
        buyIn,
        capacity: cap,
        tableNumber,
        smallBlind: opts.smallBlind ?? smallBlind,
        bigBlind: opts.bigBlind ?? bigBlind,
        minBuyIn: opts.minBuyIn ?? buyIn,
        maxBuyIn: opts.maxBuyIn ?? buyIn,
        // A five-max overflow must be humans-only like the table it spilled from.
        settings: opts.botsEnabled === false ? { botsEnabled: false } : undefined,
        session,
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
  return getTableGameBridge().getTableGameDebugSnapshot(String(tableId));
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
const POKER_OPPOSITE_DEALER_SEAT = 4;

function clampSeatPosition(value, cap = POKER_CAPACITY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return POKER_OPPOSITE_DEALER_SEAT;
  return Math.max(0, Math.min(cap - 1, Math.floor(n)));
}

function occupiedSeatPositions(seats = []) {
  const used = new Set();
  for (const s of seats) {
    if (s && s.seatPosition != null) used.add(s.seatPosition);
  }
  return used;
}

function nextFreeSeatPosition(seats = [], cap = POKER_CAPACITY) {
  const used = occupiedSeatPositions(seats);
  for (let i = 0; i < cap; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

function sortSeatsByPosition(seats = []) {
  return [...seats].sort((a, b) => {
    const pa = a.seatPosition != null ? a.seatPosition : 999;
    const pb = b.seatPosition != null ? b.seatPosition : 999;
    if (pa !== pb) return pa - pb;
    return 0;
  });
}

async function executePokerJoinTransaction({
  userId,
  playerId,
  buyIn,
  tableId,
  session,
  preferQueue = false,
  clientIp = null,
  deviceId = null,
  seatIndex = null,
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
      return enqueuePlayer({
        session,
        userId,
        playerId,
        buyIn,
        tableId: tableTx._id,
        clientIp,
        deviceId,
      });
    }
    // Do NOT find-or-create a replacement table here: that allocation must
    // go through withPokerAllocationLock (per-tier+buyIn serialization) to
    // avoid duplicate overflow tables under burst load, and that lock must
    // never be acquired while an unrelated Mongo transaction/session is open
    // (risks blocking other in-flight transactions). Throw TABLE_FULL and let
    // joinPokerWithRetry's outer catch — which already calls
    // withPokerAllocationLock outside any transaction — pick/create the next
    // table and retry.
    throw new Error("TABLE_FULL");
  }

  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.status === "closed") throw new Error("TABLE_CLOSED");
  const capNow = normalizeCapacity(tableTx.capacity);
  if (tableTx.seats.length >= capNow) {
    if (preferQueue) {
      return enqueuePlayer({
        session,
        userId,
        playerId,
        buyIn,
        tableId: tableTx._id,
        clientIp,
        deviceId,
      });
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

  const seatPosition =
    seatIndex != null
      ? clampSeatPosition(seatIndex, capNow)
      : nextFreeSeatPosition(tableTx.seats, capNow) ?? POKER_OPPOSITE_DEALER_SEAT;
  if (occupiedSeatPositions(tableTx.seats).has(seatPosition)) {
    throw new Error("SEAT_TAKEN");
  }

  tableTx.seats.push({
    user: userId,
    player: playerId,
    chips: buyIn,
    seatPosition,
  });
  if (tableTx.seats.length > capNow) throw new Error("TABLE_FULL");

  tableTx.status = statusAfterSeatChange(tableTx, tableTx.seats.length);
  await tableTx.save({ session });
  markTableActivity(String(tableTx._id));
  return {
    tableId: String(tableTx._id),
    queued: false,
    midHandJoin: isHandActiveOnTable(tableTx._id),
    seatIndex: seatPosition,
  };
}

async function joinPokerWithRetry({
  userId,
  playerId,
  buyIn,
  initialTableId,
  tier,
  preferQueue = false,
  strictTable = false,
  clientIp = null,
  deviceId = null,
  seatIndex = null,
}) {
  const maxAttempts = 8;
  let targetId = String(initialTableId);
  let lastError = null;
  const excludeIds = [];

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
          seatIndex,
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
      if (retryable && !strictTable && attempt < maxAttempts - 1) {
        if (err.message === "TABLE_FULL") excludeIds.push(targetId);
        // A stake runs both a nine-max and a five-max room, so the replacement
        // must match the size and bot policy of the table the player chose —
        // otherwise a full five-max spills into the nine-max room next door.
        // Read that off the origin only here: the happy path never needs it.
        const origin = await Table.findById(targetId)
          .select("capacity settings")
          .lean();
        const next = await withPokerAllocationLock(tier, buyIn, () =>
          findAvailablePokerTable(tier, buyIn, null, {
            excludeIds,
            capacity: normalizeCapacity(origin?.capacity ?? POKER_CAPACITY),
            botsEnabled: origin?.settings?.botsEnabled !== false,
          })
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
  POKER_OPPOSITE_DEALER_SEAT,
  clampSeatPosition,
  sortSeatsByPosition,
  nextFreeSeatPosition,
};
