/**
 * TableAllocator — central dispatch: given game+tier+buyIn+kind, find or create best destination.
 * No game engine should query Mongo directly for table allocation.
 *
 * This is a thin routing layer. The actual allocation logic and atomic join transactions
 * remain in tableAllocationService.js and pokerTableAllocationService.js.
 */
const Table = require("../models/tableModel");
const { LOBBY_EXCLUDED_STATUSES } = require("./tableLifecycleService");
const tableFactory = require("./tableFactory");
const { findAvailablePokerTable } = require("./pokerTableAllocationService");

/**
 * Find the best available static table (partial seat, sorted by tableNumber ASC to fill low tables first).
 */
async function findBestStaticTable({ gameType, tier, buyIn, session }) {
  const q = Table.findOne({
    tableKind: "static",
    gameType,
    tier,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    status: { $nin: LOBBY_EXCLUDED_STATUSES },
    $expr: { $lt: [{ $size: "$seats" }, "$capacity"] },
  }).sort({ tableNumber: 1 });
  return session ? q.session(session) : q;
}

/**
 * Find the best available dynamic table, or create a new one if all are full.
 */
async function findBestDynamicTable({ gameType, tier, buyIn, capacity = 4, session }) {
  const existing = await (session
    ? Table.findOne({
        tableKind: "dynamic",
        gameType,
        tier,
        minBuyIn: buyIn,
        maxBuyIn: buyIn,
        status: "open",
        $expr: { $lt: [{ $size: "$seats" }, "$capacity"] },
      })
        .sort({ tableNumber: 1 })
        .session(session)
    : Table.findOne({
        tableKind: "dynamic",
        gameType,
        tier,
        minBuyIn: buyIn,
        maxBuyIn: buyIn,
        status: "open",
        $expr: { $lt: [{ $size: "$seats" }, "$capacity"] },
      }).sort({ tableNumber: 1 }));
  if (existing) return existing;

  const maxDoc = await Table.findOne({ gameType, tier, minBuyIn: buyIn, maxBuyIn: buyIn })
    .sort({ tableNumber: -1 })
    .select("tableNumber")
    .session(session || null);
  const tableNumber = (maxDoc?.tableNumber || 0) + 1;

  return tableFactory.createDynamicTable({ gameType, tier, buyIn, capacity, tableNumber, session });
}

/**
 * Central allocation entry point.
 *
 * @param {object} opts
 * @param {string}  opts.gameType      - poker | trix | tarneeb41
 * @param {string}  opts.tier
 * @param {number}  opts.buyIn
 * @param {string}  [opts.tableKind]   - static (default) | dynamic | vip
 * @param {string}  [opts.preferTableId] - start here if not closed/full
 * @param {string}  [opts.userId]
 * @param {import('mongoose').ClientSession} [opts.session]
 * @returns {Promise<import('../models/tableModel').default>}
 */
async function allocate({ gameType, tier, buyIn, tableKind = "static", preferTableId, userId, session } = {}) {
  if (gameType === "poker") {
    return findAvailablePokerTable(tier, buyIn, session);
  }

  if (tableKind === "dynamic") {
    return findBestDynamicTable({ gameType, tier, buyIn, capacity: 4, session });
  }

  // Default: static
  const table = await findBestStaticTable({ gameType, tier, buyIn, session });
  if (table) return table;

  // No static slot — fall back to dynamic
  return findBestDynamicTable({ gameType, tier, buyIn, capacity: 4, session });
}

module.exports = {
  allocate,
  findBestStaticTable,
  findBestDynamicTable,
};
