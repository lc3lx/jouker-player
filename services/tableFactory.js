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
  let hashedPassword;
  if (isPrivate && password) {
    hashedPassword = await bcrypt.hash(String(password), 10);
  }

  const cap = capacity || (gameType === "poker" ? 9 : 4);
  const normalizedBuyIn = Math.trunc(Number(buyIn));
  const bigBlind = gameType === "poker" ? Math.max(1, Math.floor(normalizedBuyIn / 50)) : 0;
  const smallBlind = gameType === "poker" ? Math.max(1, Math.floor(bigBlind / 2)) : 0;

  // The unique index is (gameType, tier, tableNumber), not buy-in. Allocate
  // against that full namespace and retry a concurrent allocation collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const maxDoc = await Table.findOne({ gameType, tier })
      .sort({ tableNumber: -1 })
      .select("tableNumber");
    const tableNumber = (maxDoc?.tableNumber || 0) + 1;
    try {
      const doc = await Table.create({
        gameType,
        tier,
        tableNumber,
        tableKind: "vip",
        displayName: displayName || "VIP Table",
        smallBlind,
        bigBlind,
        minBuyIn: normalizedBuyIn,
        maxBuyIn: normalizedBuyIn,
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
      emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier, buyIn: normalizedBuyIn });
      return doc;
    } catch (err) {
      if (err?.code !== 11000 || attempt === 4) throw err;
    }
  }

  throw new Error("VIP_TABLE_NUMBER_ALLOCATION_FAILED");
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
        // Never lobby-fill with bots — only vacate/leave may convert a seat to a bot.
        settings: {
          allowSpectators: true,
          botsEnabled: false,
          minPlayers: gameType === "poker" ? 2 : 4,
          maxPlayers: cap,
          isLocked: false,
        },
      },
    ],
    createOpts
  );
  emitTablesUpdated({ gameType, reason: "table_created", tableId: String(doc._id), tier: "private" });
  return doc;
}

/**
 * Timed public-arena tournament heat. Tagged with `arenaTournament` so cash
 * settlement is skipped and scores feed the ranking at duration end.
 */
async function createArenaTournamentTable({
  gameType,
  tournamentId,
  capacity,
  displayName,
  allowedUsers,
  session,
}) {
  const maxDoc = await Table.findOne({ gameType, tier: "private" })
    .sort({ tableNumber: -1 })
    .select("tableNumber");
  const tableNumber = (maxDoc?.tableNumber || 100000) + 1;
  const cap = capacity || (gameType === "poker" ? 6 : 4);
  const createOpts = session ? { session } : {};
  const [doc] = await Table.create(
    [
      {
        gameType,
        tier: "private",
        tableNumber,
        tableKind: "tournament",
        displayName: displayName || "Arena Tournament",
        smallBlind: 0,
        bigBlind: 0,
        minBuyIn: 0,
        maxBuyIn: 0,
        capacity: cap,
        isPrivate: true,
        status: gameType === "poker" ? "waiting" : "open",
        arenaTournament: tournamentId,
        allowedUsers: allowedUsers || [],
        seats: [],
        settings: {
          allowSpectators: true,
          botsEnabled: false,
          minPlayers: gameType === "poker" ? 2 : 4,
          maxPlayers: cap,
          isLocked: false,
        },
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

/**
 * Force botsEnabled=false on every open tournament table.
 * Safe to call from scheduler ticks — covers tables created before the lock
 * and any accidental default=true settings. Vacate-replace still works because
 * it calls createBotSeat / convertHumanToBot directly (not addBotsForMissingSeats).
 *
 * IMPORTANT: never use `{ field: { $ne: null } }` alone — in Mongo that also
 * matches documents where `field` is missing, which disabled bots on almost
 * every cash table after the 2026-08-22 hardening commit.
 */
async function lockTournamentBotsOnOpenTables() {
  const tournamentFilter = {
    $or: [
      { tableKind: "tournament" },
      {
        clanTournamentMatch: { $exists: true, $ne: null },
      },
      {
        arenaTournament: { $exists: true, $ne: null },
      },
    ],
    status: { $nin: ["archived", "closed"] },
    "settings.botsEnabled": { $ne: false },
  };
  const locked = await Table.updateMany(tournamentFilter, {
    $set: { "settings.botsEnabled": false },
  });

  // Repair collateral damage from the bad `$ne: null` filter (cash tables).
  const repaired = await Table.updateMany(
    {
      status: { $nin: ["archived", "closed"] },
      "settings.botsEnabled": false,
      tableKind: { $nin: ["tournament"] },
      $and: [
        {
          $or: [
            { clanTournamentMatch: { $exists: false } },
            { clanTournamentMatch: null },
          ],
        },
        {
          $or: [
            { arenaTournament: { $exists: false } },
            { arenaTournament: null },
          ],
        },
      ],
    },
    { $set: { "settings.botsEnabled": true } }
  );

  return {
    matched: locked.matchedCount,
    modified: locked.modifiedCount,
    repaired: repaired.modifiedCount,
  };
}

module.exports = {
  createStaticTable,
  createDynamicTable,
  createVipTable,
  createTournamentTable,
  createArenaTournamentTable,
  destroyOrArchiveTable,
  lockTournamentBotsOnOpenTables,
};
