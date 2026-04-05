const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const { withMongoTransaction, transferToLocked, transferToBalance } = require("./walletLedgerService");
const { getTableGameDebugSnapshot } = require("../sockets/tableGame");
const { assertNotTrustRestricted, trackJoinLeaveEvent } = require("./fraudService");
const { trackEventServerFireAndForget } = require("./analyticsService");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");

const FIXED_TIER_TABLES = {
  beginner: [10000, 40000, 100000, 150000],
  intermediate: [200000, 400000, 800000, 1000000],
  beast: [1500000, 2000000, 5000000, 10000000],
};

const FIXED_TABLE_NUMBERS = [1, 2, 3, 4];
let fixedTablesReady = false;
let fixedTablesReadyPromise = null;
/** After Mongo had only { tier, tableNumber } unique, trix+poker rows conflict. Drop once. */
let tablesLegacyUniqueIndexHandled = false;

/**
 * Drops the old unique index on (tier, tableNumber) so (gameType, tier, tableNumber) can coexist.
 * Safe to call multiple times; runs once per process.
 */
async function migrateTablesLegacyUniqueIndex() {
  if (tablesLegacyUniqueIndexHandled) return;
  tablesLegacyUniqueIndexHandled = true;
  try {
    const coll = Table.collection;
    const indexes = await coll.indexes();
    for (const ix of indexes) {
      const key = ix.key || {};
      const isLegacyPair =
        Object.keys(key).length === 2 &&
        key.tier === 1 &&
        key.tableNumber === 1 &&
        key.gameType === undefined;
      if (!isLegacyPair) continue;
      if (ix.name === "_id_") continue;
      // E11000 comes from the old *unique* (tier, tableNumber); keep other indexes
      if (ix.unique !== true) continue;
      try {
        await coll.dropIndex(ix.name);
        console.log(
          `[tables] dropped legacy index "${ix.name}" — use unique on (gameType, tier, tableNumber)`
        );
      } catch (dropErr) {
        console.warn(`[tables] could not drop index ${ix.name}:`, dropErr.message);
      }
    }
    await Table.syncIndexes();
  } catch (e) {
    console.warn("[tables] migrate legacy indexes:", e.message);
  }
}

function deriveBlindsFromBuyIn(buyIn) {
  const bigBlind = Math.max(100, Math.floor(Number(buyIn || 0) / 50));
  const smallBlind = Math.max(50, Math.floor(bigBlind / 2));
  return { smallBlind, bigBlind };
}

async function ensureFixedTierTables() {
  if (fixedTablesReady) return;
  if (fixedTablesReadyPromise) return fixedTablesReadyPromise;

  fixedTablesReadyPromise = (async () => {
    await migrateTablesLegacyUniqueIndex();

    await Table.updateMany(
      { gameType: { $exists: false } },
      { $set: { gameType: "poker" } }
    );

    const ops = [];

    for (const [tier, buyIns] of Object.entries(FIXED_TIER_TABLES)) {
      buyIns.forEach((buyIn, index) => {
        const tableNumber = index + 1;
        const { smallBlind, bigBlind } = deriveBlindsFromBuyIn(buyIn);

        ops.push({
          updateOne: {
            filter: { gameType: "poker", tier, tableNumber },
            update: {
              $set: {
                gameType: "poker",
                smallBlind,
                bigBlind,
                minBuyIn: buyIn,
                maxBuyIn: buyIn,
                capacity: 9,
                isPrivate: false,
                status: "open",
              },
              $unset: { password: 1 },
            },
            upsert: true,
          },
        });
      });
    }

    for (const [tier, buyIns] of Object.entries(FIXED_TIER_TABLES)) {
      buyIns.forEach((buyIn, index) => {
        const tableNumber = index + 1;
        ops.push({
          updateOne: {
            filter: { gameType: "trix", tier, tableNumber },
            update: {
              $set: {
                gameType: "trix",
                smallBlind: 0,
                bigBlind: 0,
                minBuyIn: buyIn,
                maxBuyIn: buyIn,
                capacity: 4,
                isPrivate: false,
                status: "open",
              },
              $unset: { password: 1 },
            },
            upsert: true,
          },
        });
      });
    }

    for (const [tier, buyIns] of Object.entries(FIXED_TIER_TABLES)) {
      buyIns.forEach((buyIn, index) => {
        const tableNumber = index + 1;
        ops.push({
          updateOne: {
            filter: { gameType: "tarneeb41", tier, tableNumber },
            update: {
              $set: {
                gameType: "tarneeb41",
                smallBlind: 0,
                bigBlind: 0,
                minBuyIn: buyIn,
                maxBuyIn: buyIn,
                capacity: 4,
                isPrivate: false,
                status: "open",
              },
              $unset: { password: 1 },
            },
            upsert: true,
          },
        });
      });
    }

    if (ops.length > 0) {
      await Table.bulkWrite(ops, { ordered: false });
    }

    fixedTablesReady = true;
  })().finally(() => {
    fixedTablesReadyPromise = null;
  });

  return fixedTablesReadyPromise;
}

// List tables with optional tier filter
exports.getTables = asyncHandler(async (req, res) => {
  await ensureFixedTierTables();

  let gameType = "poker";
  if (req.query.gameType === "trix") gameType = "trix";
  else if (req.query.gameType === "tarneeb41") gameType = "tarneeb41";
  const filter = { gameType };
  if (req.query.tier) {
    filter.tier = req.query.tier;
  }
  if (filter.tier && FIXED_TIER_TABLES[filter.tier]) {
    filter.tableNumber = { $in: FIXED_TABLE_NUMBERS };
  }
  if (req.query.status) {
    filter.status = req.query.status;
  } else {
    filter.status = "open";
  }

  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "20", 10);
  const skip = (page - 1) * limit;

  const total = await Table.countDocuments(filter);
  const tables = await Table.find(filter)
    .sort({ smallBlind: 1, bigBlind: 1, tableNumber: 1 })
    .skip(skip)
    .limit(limit)
    .select(
      "gameType tier tableNumber smallBlind bigBlind minBuyIn maxBuyIn capacity seats status"
    );

  const withLive = String(req.query.live || "") === "1";
  const data = tables.map((t) => {
    const o = t.toObject ? t.toObject() : t;
    if (!withLive || gameType !== "poker") return o;
    const live = getTableGameDebugSnapshot(String(t._id));
    const playing =
      live &&
      live.running === true &&
      live.round &&
      String(live.round) !== "idle";
    return {
      ...o,
      liveStatus: playing ? "playing" : "waiting",
      liveRound: live?.round || null,
      livePot: live?.pot ?? null,
    };
  });

  res.status(200).json({
    results: tables.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(total / limit),
      next: page * limit < total ? page + 1 : null,
    },
    data,
  });
});

// Get table by id
exports.getTable = asyncHandler(async (req, res, next) => {
  const table = await Table.findById(req.params.id).populate({
    path: "seats.user",
    select: "name country profileImg",
  });
  if (!table) return next(new ApiError(`No table for id ${req.params.id}`, 404));
  res.status(200).json({ data: table });
});

// Create a new table (admin/manager)
exports.createTable = asyncHandler(async (req, res) => {
  const gt = req.body.gameType;
  const gameType =
    gt === "trix" ? "trix" : gt === "tarneeb41" ? "tarneeb41" : "poker";
  const defaultCap =
    gameType === "trix" || gameType === "tarneeb41" ? 4 : 9;
  const table = await Table.create({
    gameType,
    tier: req.body.tier,
    tableNumber: req.body.tableNumber,
    smallBlind: req.body.smallBlind,
    bigBlind: req.body.bigBlind,
    minBuyIn: req.body.minBuyIn,
    maxBuyIn: req.body.maxBuyIn,
    capacity: req.body.capacity || defaultCap,
    isPrivate: !!req.body.isPrivate,
    password: req.body.password,
    status: "open",
  });
  res.status(201).json({ data: table });
});

// Join a table (protected)
exports.joinTable = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const buyIn = Number(req.body.buyIn || 0);
  const password = req.body.password;

  const table = await Table.findById(id);
  if (!table) return next(new ApiError("Table not found", 404));
  if (table.status !== "open") return next(new ApiError("Table is closed", 400));
  if (table.seats.length >= table.capacity)
    return next(new ApiError("Table is full", 400));

  // Check private table password
  if (table.isPrivate) {
    if (!password || password !== table.password) {
      return next(new ApiError("Invalid table password", 400));
    }
  }

  // Already seated?
  const already = table.seats.find((s) => String(s.user) === String(req.user._id));
  if (already) return next(new ApiError("You are already seated at this table", 400));

  // Buy-in constraints
  if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
    return next(
      new ApiError(
        `Buy-in must be between ${table.minBuyIn} and ${table.maxBuyIn}`,
        400
      )
    );
  }

  try {
    await assertNotTrustRestricted(req.user._id);
  } catch (e) {
    if (e.message === "TRUST_RESTRICTED") {
      throw new ApiError("Account restricted — contact support", 403);
    }
    throw e;
  }

  // Wallet check (available balance only)
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) wallet = await Wallet.create({ user: req.user._id });
  if (!wallet.hasSufficientAvailable(buyIn)) {
    return next(new ApiError("Insufficient wallet balance", 400));
  }

  // Ensure player exists
  const player = await Player.getOrCreateByUser(req.user._id);

  // Atomic: lock funds + seat user
  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(id).session(session);
    if (!tableTx) throw new Error("TABLE_NOT_FOUND");
    if (tableTx.status !== "open") throw new Error("TABLE_CLOSED");
    if (tableTx.seats.length >= tableTx.capacity) throw new Error("TABLE_FULL");
    const alreadyTx = tableTx.seats.find((s) => String(s.user) === String(req.user._id));
    if (alreadyTx) throw new Error("ALREADY_SEATED");

    await transferToLocked({
      session,
      userId: req.user._id,
      amount: buyIn,
      tableId: tableTx._id,
      meta: { reason: "join_table", tableNumber: tableTx.tableNumber },
    });

    tableTx.seats.push({ user: req.user._id, player: player._id, chips: buyIn });
    await tableTx.save({ session });
  }).catch((e) => {
    if (e.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("Insufficient wallet balance", 400);
    }
    if (e.message === "TABLE_NOT_FOUND") throw new ApiError("Table not found", 404);
    if (e.message === "TABLE_CLOSED") throw new ApiError("Table is closed", 400);
    if (e.message === "TABLE_FULL") throw new ApiError("Table is full", 400);
    if (e.message === "ALREADY_SEATED") throw new ApiError("You are already seated at this table", 400);
    throw e;
  });

  void trackJoinLeaveEvent(req.user._id, "join_table");
  trackEventServerFireAndForget(
    "user_join_table",
    req.user._id,
    { tableId: String(table._id), tier: table.tier, tableNumber: table.tableNumber },
    "server"
  );
  emitTablesUpdated({ gameType: "poker", reason: "join", tableId: String(table._id) });

  res.status(200).json({
    status: "success",
    message: "Joined table successfully",
    data: {
      tableId: table._id,
      tableNumber: table.tableNumber,
      chips: buyIn,
      rtcRoom: { roomId: table._id, type: "table" },
    },
  });
});

// Leave a table (protected)
exports.leaveTable = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const table = await Table.findById(id);
  if (!table) return next(new ApiError("Table not found", 404));

  const idx = table.seats.findIndex((s) => String(s.user) === String(req.user._id));
  if (idx === -1) return next(new ApiError("You are not seated at this table", 400));

  const chips = table.seats[idx].chips || 0;
  // Atomic: remove seat + unlock funds to balance
  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(id).session(session);
    if (!tableTx) throw new Error("TABLE_NOT_FOUND");

    const idxTx = tableTx.seats.findIndex((s) => String(s.user) === String(req.user._id));
    if (idxTx === -1) throw new Error("NOT_SEATED");
    const chipsTx = tableTx.seats[idxTx].chips || 0;

    tableTx.seats.splice(idxTx, 1);
    await tableTx.save({ session });

    if (chipsTx > 0) {
      await transferToBalance({
        session,
        userId: req.user._id,
        amount: chipsTx,
        tableId: tableTx._id,
        meta: { reason: "leave_table_cashout", tableNumber: tableTx.tableNumber },
      });
    }
  }).catch((e) => {
    if (e.message === "TABLE_NOT_FOUND") throw new ApiError("Table not found", 404);
    if (e.message === "NOT_SEATED") throw new ApiError("You are not seated at this table", 400);
    if (e.message === "INSUFFICIENT_LOCKED_BALANCE") {
      throw new ApiError("Wallet locked balance inconsistency", 400);
    }
    throw e;
  });

  void trackJoinLeaveEvent(req.user._id, "leave_table");
  emitTablesUpdated({ gameType: "poker", reason: "leave", tableId: String(table._id) });

  res.status(200).json({
    status: "success",
    data: { cashedOut: chips, rtcRoom: { roomId: table._id, type: "table" } },
  });
});
