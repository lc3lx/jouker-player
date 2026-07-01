/**
 * Unified first-fit table allocation + retry join for Tarneeb41, Trix, and Poker.
 */
const Table = require("../models/tableModel");
const { withMongoTransaction, transferToLocked } = require("./walletLedgerService");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const { LOBBY_EXCLUDED_STATUSES } = require("./tableLifecycleService");
const tableFactory = require("./tableFactory");
const {
  findAvailablePokerTable,
  joinPokerWithRetry,
} = require("./pokerTableAllocationService");

const MAX_JOIN_ATTEMPTS = 3;

function deriveBlindsFromBuyIn(buyIn) {
  const bigBlind = Math.max(100, Math.floor(Number(buyIn || 0) / 50));
  const smallBlind = Math.max(50, Math.floor(bigBlind / 2));
  return { smallBlind, bigBlind };
}

/**
 * Find user's active seated table for a game type + tier (reconnect anchor).
 */
async function findUserSeatedTable(userId, gameType, tier) {
  return Table.findOne({
    gameType,
    tier,
    status: { $nin: LOBBY_EXCLUDED_STATUSES },
    "seats.user": userId,
  }).select("tableNumber seats minBuyIn maxBuyIn gameType tier status");
}

/**
 * Generic first-fit: find partial table or create dynamic instance.
 * @param {object} opts
 * @param {string} opts.gameType - tarneeb41 | trix | poker
 * @param {string} opts.tier
 * @param {number} opts.buyIn
 * @param {import('mongoose').ClientSession} [opts.session]
 */
async function findAvailableTable({ gameType, tier, buyIn, session }) {
  if (gameType === "poker") {
    return findAvailablePokerTable(tier, buyIn, session);
  }
  return findAvailableFixedCapacityTable({ gameType, tier, buyIn, capacity: 4, session });
}

async function findAvailableFixedCapacityTable({ gameType, tier, buyIn, capacity, session }) {
  const q = {
    gameType,
    tier,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    status: "open",
    $expr: { $lt: [{ $size: "$seats" }, "$capacity"] },
  };
  let query = Table.findOne(q).sort({ tableNumber: 1 });
  if (session) query = query.session(session);
  let table = await query;
  if (table) return table;

  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt += 1) {
    const maxDoc = await Table.findOne({ gameType, tier, minBuyIn: buyIn, maxBuyIn: buyIn })
      .sort({ tableNumber: -1 })
      .select("tableNumber")
      .session(session || null);
    const tableNumber = (maxDoc?.tableNumber || 0) + 1 + attempt;
    try {
      table = await tableFactory.createDynamicTable({
        gameType,
        tier,
        buyIn,
        capacity,
        tableNumber,
        session,
      });
      return table;
    } catch (err) {
      if (err && err.code === 11000 && attempt < MAX_JOIN_ATTEMPTS - 1) continue;
      throw err;
    }
  }
  throw new Error("TABLE_CREATE_FAILED");
}

async function executeFixedCapacityJoinTransaction({
  gameType,
  userId,
  playerId,
  buyIn,
  tableId,
  session,
}) {
  let tableTx = await Table.findById(tableId).session(session);
  if (!tableTx) throw new Error("TABLE_NOT_FOUND");
  if (tableTx.gameType !== gameType) throw new Error("GAME_TYPE_MISMATCH");

  if (tableTx.status === "playing" || tableTx.seats.length >= tableTx.capacity) {
    tableTx = await findAvailableTable({ gameType, tier: tableTx.tier, buyIn, session });
  }

  if (tableTx.seats.length >= tableTx.capacity) throw new Error("TABLE_FULL");
  const alreadyTx = tableTx.seats.find((s) => String(s.user) === String(userId));
  if (alreadyTx) throw new Error("ALREADY_SEATED");

  await transferToLocked({
    session,
    userId,
    amount: buyIn,
    tableId: tableTx._id,
    meta: { reason: "join_table", tableNumber: tableTx.tableNumber },
  });

  tableTx.seats.push({ user: userId, player: playerId, chips: buyIn });
  if (tableTx.seats.length >= tableTx.capacity) {
    tableTx.status = "playing";
  }
  await tableTx.save({ session });
  return String(tableTx._id);
}

async function joinFixedCapacityWithRetry({
  gameType,
  userId,
  playerId,
  buyIn,
  initialTableId,
  tier,
}) {
  let targetId = String(initialTableId);
  let lastError = null;

  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt += 1) {
    try {
      let joinedId = targetId;
      await withMongoTransaction(async (session) => {
        joinedId = await executeFixedCapacityJoinTransaction({
          gameType,
          userId,
          playerId,
          buyIn,
          tableId: targetId,
          session,
        });
      });
      return joinedId;
    } catch (err) {
      lastError = err;
      const retryable =
        err.message === "TABLE_FULL" ||
        err.message === "WriteConflict" ||
        (err.errorLabels && err.errorLabels.has("TransientTransactionError"));
      if (retryable && attempt < MAX_JOIN_ATTEMPTS - 1) {
        const next = await findAvailableTable({ gameType, tier, buyIn });
        targetId = String(next._id);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("TABLE_FULL");
}

/** @deprecated use findAvailableTable */
const findAvailableTarneeb41Table = (tier, buyIn, session) =>
  findAvailableFixedCapacityTable({ gameType: "tarneeb41", tier, buyIn, capacity: 4, session });

/** @deprecated use findAvailableTable */
const findAvailableTrixTable = (tier, buyIn, session) =>
  findAvailableFixedCapacityTable({ gameType: "trix", tier, buyIn, capacity: 4, session });

module.exports = {
  MAX_JOIN_ATTEMPTS,
  findUserSeatedTable,
  findAvailableTable,
  findAvailableTarneeb41Table,
  findAvailableTrixTable,
  joinFixedCapacityWithRetry,
  joinPokerWithRetry,
};
