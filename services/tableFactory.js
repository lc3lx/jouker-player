/**
 * TableFactory — single creation entrypoint for all Table documents.
 * No other file should call Table.create() to create new tables.
 */
const bcrypt = require("bcryptjs");
const Table = require("../models/tableModel");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const { archiveTableDocument } = require("./tableLifecycleService");

/**
 * Creates or upserts a permanent static table.
 * Primarily used by ensureFixedTierTables (upsert path via bulkWrite).
 * Direct creation path for admin-requested static tables.
 */
async function createStaticTable({ gameType, tier, buyIn, tableNumber, capacity, session }) {
  const cap = capacity || (gameType === "poker" ? 9 : 4);
  const createOpts = session ? { session } : {};
  const [doc] = await Table.create(
    [
      {
        gameType,
        tier,
        tableNumber,
        tableKind: "static",
        smallBlind: 0,
        bigBlind: 0,
        minBuyIn: buyIn,
        maxBuyIn: buyIn,
        capacity: cap,
        isPrivate: false,
        status: gameType === "poker" ? "waiting" : "open",
        seats: [],
      },
    ],
    createOpts
  );
  emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier, buyIn });
  return doc;
}

/**
 * Creates a dynamic (auto-scaled) table.
 * tableNumber must be supplied by the caller (computed in the retry loop).
 * Sets tableKind:"dynamic" and displayName:"Dynamic #N".
 */
async function createDynamicTable({
  gameType,
  tier,
  buyIn,
  capacity,
  tableNumber,
  smallBlind = 0,
  bigBlind = 0,
  session,
}) {
  const createOpts = session ? { session } : {};
  const [doc] = await Table.create(
    [
      {
        gameType,
        tier,
        tableNumber,
        tableKind: "dynamic",
        displayName: `Dynamic #${tableNumber}`,
        smallBlind,
        bigBlind,
        minBuyIn: buyIn,
        maxBuyIn: buyIn,
        capacity,
        isPrivate: false,
        status: gameType === "poker" ? "waiting" : "open",
        seats: [],
      },
    ],
    createOpts
  );
  emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier, buyIn });
  return doc;
}

/**
 * Creates a VIP table owned by ownerId.
 * If isPrivate + password are both provided, password is bcrypt-hashed before storage.
 */
async function createVipTable({
  gameType,
  tier,
  buyIn,
  capacity,
  ownerId,
  displayName,
  isPrivate = false,
  password,
  settings = {},
}) {
  const maxDoc = await Table.findOne({ gameType, tier, minBuyIn: buyIn, maxBuyIn: buyIn })
    .sort({ tableNumber: -1 })
    .select("tableNumber");
  const tableNumber = (maxDoc?.tableNumber || 0) + 1;

  let hashedPassword;
  if (isPrivate && password) {
    hashedPassword = await bcrypt.hash(String(password), 10);
  }

  const cap = capacity || (gameType === "poker" ? 9 : 4);
  const doc = await Table.create({
    gameType,
    tier,
    tableNumber,
    tableKind: "vip",
    displayName: displayName || "VIP Table",
    smallBlind: 0,
    bigBlind: 0,
    minBuyIn: buyIn,
    maxBuyIn: buyIn,
    capacity: cap,
    isPrivate,
    password: hashedPassword,
    owner: ownerId,
    status: gameType === "poker" ? "waiting" : "open",
    settings: {
      allowSpectators: settings.allowSpectators !== false,
      botsEnabled: settings.botsEnabled !== false,
      minPlayers: settings.minPlayers || 2,
      maxPlayers: settings.maxPlayers || cap,
      isLocked: false,
    },
    seats: [],
  });

  emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier, buyIn });
  return doc;
}

/**
 * Creates an ephemeral private table that hosts a single clan-tournament match.
 * Tagged with `clanTournamentMatch` so the game-finish hook resolves the bracket
 * (and skips cash settlement — tournament matches never move wallet coins).
 */
async function createTournamentTable({ gameType, matchId, capacity, session }) {
  const maxDoc = await Table.findOne({ gameType, tier: "private" })
    .sort({ tableNumber: -1 })
    .select("tableNumber");
  const tableNumber = (maxDoc?.tableNumber || 100000) + 1;
  const cap = capacity || (gameType === "poker" ? 9 : 4);
  const createOpts = session ? { session } : {};
  const [doc] = await Table.create(
    [
      {
        gameType,
        tier: "private",
        tableNumber,
        tableKind: "tournament",
        displayName: "Tournament Match",
        smallBlind: 0,
        bigBlind: 0,
        minBuyIn: 0,
        maxBuyIn: 0,
        capacity: cap,
        isPrivate: true,
        status: gameType === "poker" ? "waiting" : "open",
        clanTournamentMatch: matchId,
        seats: [],
      },
    ],
    createOpts
  );
  emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier: "private" });
  return doc;
}

/**
 * Destroy or archive a table based on its kind:
 * - dynamic / vip → DELETE from Mongo (ephemeral; never permanent)
 * - static / tournament → archive (status:"archived", seats cleared — preserves history)
 *
 * Emits tables_updated after the operation.
 */
async function destroyOrArchiveTable(tableId, { reason = "idle", session } = {}) {
  const tid = String(tableId);
  const table = await Table.findById(tid).select("tableKind gameType");
  if (!table) return { done: false, reason: "not_found" };

  if (table.tableKind === "dynamic" || table.tableKind === "vip") {
    const q = Table.deleteOne({ _id: tid });
    if (session) await q.session(session);
    else await q;
    emitTablesUpdated({ gameType: table.gameType, reason: "table_removed", tableId: tid });
    return { done: true, deleted: true, tableId: tid };
  }

  return archiveTableDocument(tid, { reason, session });
}

module.exports = {
  createStaticTable,
  createDynamicTable,
  createVipTable,
  createTournamentTable,
  destroyOrArchiveTable,
};
