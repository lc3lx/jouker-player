const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const { withMongoTransaction, transferToLocked, releaseTableSeatToBalance } = require("./walletLedgerService");
const { isTableSettlementBlocked } = require("./gameSettlementService");
const { getTableGameDebugSnapshot } = require("../sockets/tableGame");
const { assertNotTrustRestricted, trackJoinLeaveEvent } = require("./fraudService");
const { trackEventServerFireAndForget } = require("./analyticsService");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const roomManager = require("../rooms/roomManager");
const {
  buildPokerLobbyFields,
  derivePokerTableStatus,
  normalizeCapacity,
  countMongoSeats,
} = require("../utils/pokerTableStatus");
const {
  joinPokerWithRetry,
  syncPokerTableStatusById,
  statusAfterSeatChange,
} = require("./pokerTableAllocationService");
const {
  findUserSeatedTable,
  findAvailableTable,
  findAvailableTarneeb41Table,
  findAvailableTrixTable,
  joinFixedCapacityWithRetry,
} = require("./tableAllocationService");
const { LOBBY_EXCLUDED_STATUSES } = require("./tableLifecycleService");
const { seatNextFromQueue, getQueuePosition, getWaitingQueueSize } = require("./pokerWaitingQueueService");
const { removeSeatPresence } = require("./pokerCollusionGuard");
const { markTableActivity, resetPokerTableWhenEmpty } = require("./pokerTableGcService");
const { syncLivePokerTableAfterLeave, syncLivePokerTableAfterJoin } = require("../sockets/tableGame");
const { vacatePokerSeat, tryRestoreVacatedSeat } = require("./pokerVacateService");

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
                status: "waiting",
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

    // Migrate legacy poker `open` / `playing` statuses to waiting|ready|full.
    const legacyPoker = await Table.find({
      gameType: "poker",
      status: { $in: ["open", "playing"] },
    }).select("seats capacity status");
    for (const doc of legacyPoker) {
      const cap = normalizeCapacity(doc.capacity);
      doc.capacity = cap;
      doc.status = derivePokerTableStatus({
        mongoSeatCount: countMongoSeats(doc.seats),
        capacity: cap,
        running: false,
        round: "idle",
      });
      await doc.save();
    }

    fixedTablesReady = true;
  })().finally(() => {
    fixedTablesReadyPromise = null;
  });

  return fixedTablesReadyPromise;
}

/**
 * Reload Mongo seats into game and verify start eligibility (exactly 4 humans).
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function validateTarneeb41StartEligibility(tableId, game) {
  const table = await Table.findById(tableId).populate({
    path: "seats.user",
    select: "name country profileImg",
  });
  if (!table) return { ok: false, reason: "table_not_found" };
  if (table.gameType !== "tarneeb41") return { ok: false, reason: "not_tarneeb41" };
  if (table.status === "closed" || table.status === "archived") return { ok: false, reason: "table_closed" };
  if (table.seats.length !== 4) return { ok: false, reason: "seats_not_four" };

  game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));

  if (game.players.length !== 4 || game.humanCount() !== 4) {
    return { ok: false, reason: "roster_not_four" };
  }
  return { ok: true };
}

async function refreshTarneeb41GameSeats(tableId) {
  const table = await Table.findById(tableId).populate({
    path: "seats.user",
    select: "name country profileImg",
  });
  if (!table) return;
  const game = roomManager.getTarneeb41GameForTable(tableId);
  if (!game) return;
  if (game.state === "countdown") {
    game.cancelGameCountdown("seats_changed");
  }
  if (game.state === "waiting" || game.state === "countdown") {
    game.syncLobbyFromTable(table, (uid) => roomManager.getTarneeb41UserSocket(String(uid)));
    if (game.isReadyForCountdown()) {
      game.startGameCountdown();
    }
  }
}

async function refreshTrixGameSeats(tableId) {
  const table = await Table.findById(tableId).populate({
    path: "seats.user",
    select: "name country profileImg",
  });
  if (!table) return;
  const game = roomManager.getTrixGameForTable(tableId);
  if (!game) return;
  if (game.state === "waiting") {
    game.syncLobbyFromTable(table, (uid) => roomManager.getTrixUserSocket(String(uid)));
  }
}

/** Mark Mongo trix table as actively playing (mirrors tarneeb41 full-table join). */
async function markTrixTablePlaying(tableId) {
  if (!tableId) return null;
  return Table.findByIdAndUpdate(
    tableId,
    { $set: { status: "playing" } },
    { new: true }
  );
}

exports.findAvailableTarneeb41Table = findAvailableTarneeb41Table;
exports.findAvailableTrixTable = findAvailableTrixTable;
exports.findAvailableTable = findAvailableTable;
exports.findUserSeatedTable = findUserSeatedTable;
exports.validateTarneeb41StartEligibility = validateTarneeb41StartEligibility;
exports.joinFixedCapacityWithRetry = joinFixedCapacityWithRetry;
exports.joinTarneeb41WithRetry = (opts) =>
  joinFixedCapacityWithRetry({ ...opts, gameType: "tarneeb41" });
exports.joinTrixWithRetry = (opts) =>
  joinFixedCapacityWithRetry({ ...opts, gameType: "trix" });
exports.refreshTarneeb41GameSeats = refreshTarneeb41GameSeats;
exports.refreshTrixGameSeats = refreshTrixGameSeats;
exports.markTrixTablePlaying = markTrixTablePlaying;

function enrichPokerTableRow(tableObj, live) {
  const seatedCount = countMongoSeats(tableObj.seats);
  const cap = normalizeCapacity(tableObj.capacity);
  const playing =
    live &&
    live.running === true &&
    live.round &&
    String(live.round) !== "idle";
  const tableStatus =
    tableObj.status && ["waiting", "ready", "playing", "full"].includes(tableObj.status)
      ? tableObj.status
      : derivePokerTableStatus({
          mongoSeatCount: seatedCount,
          capacity: cap,
          running: live?.running,
          round: live?.round,
        });
  const lobby = buildPokerLobbyFields({
    mongoSeatCount: seatedCount,
    capacity: cap,
    running: live?.running,
    round: live?.round,
  });
  return {
    ...tableObj,
    capacity: cap,
    seatedCount,
    playersNeeded: lobby.playersNeeded,
    tableStatus,
    canStart: lobby.canStart,
    liveStatus: playing ? "playing" : tableStatus,
    liveRound: live?.round || null,
    livePot: live?.pot ?? null,
  };
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

  if (gameType === "poker") {
    const rawStatus = req.query.status;
    // Legacy clients send status=open (trix/tarneeb); poker uses waiting|ready|playing|full.
    if (rawStatus && rawStatus !== "open") {
      filter.status = rawStatus;
    } else {
      filter.status = { $nin: LOBBY_EXCLUDED_STATUSES };
    }
    const buyIn = Number(req.query.buyIn || 0);
    if (Number.isFinite(buyIn) && buyIn > 0) {
      filter.minBuyIn = buyIn;
      filter.maxBuyIn = buyIn;
    }
  } else if (gameType === "tarneeb41" && !req.query.status) {
    filter.status = "open";
    filter.$expr = { $lt: [{ $size: "$seats" }, "$capacity"] };
  } else if (gameType === "trix" && !req.query.status) {
    filter.status = "open";
    filter.$expr = { $lt: [{ $size: "$seats" }, "$capacity"] };
  } else if (req.query.status) {
    filter.status = req.query.status;
  } else {
    filter.status = "open";
  }

  const page = parseInt(req.query.page || "1", 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const skip = (page - 1) * limit;

  const total = await Table.countDocuments(filter);
  const tables = await Table.find(filter)
    .sort({ smallBlind: 1, bigBlind: 1, tableNumber: 1 })
    .skip(skip)
    .limit(limit)
    .select(
      "gameType tier tableNumber smallBlind bigBlind minBuyIn maxBuyIn capacity seats status waitingQueue vacatingPlayers"
    );

  const withLive = String(req.query.live || "") === "1";
  const data = await Promise.all(
    tables.map(async (t) => {
      const o = t.toObject ? t.toObject() : t;
      if (gameType !== "poker") return o;
      const live = withLive ? getTableGameDebugSnapshot(String(t._id)) : null;
      const row = enrichPokerTableRow(o, live);
      const qLen = await getWaitingQueueSize(String(t._id));
      return { ...row, waitingQueueSize: qLen };
    })
  );

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
    capacity: Math.min(9, req.body.capacity || defaultCap),
    isPrivate: !!req.body.isPrivate,
    password: req.body.password,
    status: gameType === "poker" ? "waiting" : "open",
  });
  res.status(201).json({ data: table });
});

// Join a table (protected)
exports.joinTable = asyncHandler(async (req, res, next) => {
  let { id } = req.params;
  const buyIn = Number(req.body.buyIn || 0);
  const password = req.body.password;

  let table = await Table.findById(id);
  if (!table) return next(new ApiError("Table not found", 404));

  if (LOBBY_EXCLUDED_STATUSES.includes(table.status)) {
    if (table.gameType === "tarneeb41" || table.gameType === "trix") {
      table = await findAvailableTable({
        gameType: table.gameType,
        tier: table.tier,
        buyIn,
      });
      id = String(table._id);
    } else if (table.gameType === "poker") {
      return next(new ApiError("Table is closed", 400));
    } else {
      return next(new ApiError("Table is closed", 400));
    }
  }

  // Reconnect anchor: user already seated at an active table for this tier — skip re-join.
  if (table.gameType === "poker") {
    const vacRestore = await tryRestoreVacatedSeat({
      tableId: id,
      userId: req.user._id,
    });
    if (vacRestore) {
      void trackJoinLeaveEvent(req.user._id, "join_table");
      emitTablesUpdated({ gameType: "poker", reason: "vacate_restore", tableId: id });
      void syncPokerTableStatusById(id);
      return res.status(200).json({
        status: "success",
        message: "Seat restored — return within vacate window",
        data: {
          tableId: String(id),
          tableNumber: table.tableNumber,
          chips: vacRestore.chips,
          reconnect: true,
          vacateRestore: true,
          rtcRoom: { roomId: String(id), type: "table" },
        },
      });
    }
  }

  const existingSeatTable = await findUserSeatedTable(req.user._id, table.gameType, table.tier);
  if (existingSeatTable) {
    const seat = existingSeatTable.seats.find(
      (s) => String(s.user) === String(req.user._id)
    );
    return res.status(200).json({
      status: "success",
      message: "Reconnected to existing seat",
      data: {
        tableId: String(existingSeatTable._id),
        tableNumber: existingSeatTable.tableNumber,
        chips: seat?.chips ?? buyIn,
        reconnect: true,
        rtcRoom: { roomId: String(existingSeatTable._id), type: "table" },
      },
    });
  }

  if (table.gameType === "tarneeb41") {
    if (table.status === "playing" || table.seats.length >= table.capacity) {
      table = await findAvailableTarneeb41Table(table.tier, buyIn);
      id = String(table._id);
    }
  } else if (table.gameType === "trix") {
    if (table.status === "playing" || table.seats.length >= table.capacity) {
      table = await findAvailableTrixTable(table.tier, buyIn);
      id = String(table._id);
    }
  } else if (table.gameType === "poker") {
    if (table.status === "closed" || table.status === "archived") {
      return next(new ApiError("Table is closed", 400));
    }
  } else if (table.status !== "open") {
    return next(new ApiError("Table is closed", 400));
  }

  if (table.gameType === "poker") {
    // full-table routing handled inside joinPokerWithRetry
  } else if (table.seats.length >= table.capacity) {
    return next(new ApiError("Table is full", 400));
  }

  // Check private table password
  if (table.isPrivate) {
    if (!password || password !== table.password) {
      return next(new ApiError("Invalid table password", 400));
    }
  }

  // Already seated at the requested table (legacy path — should be caught by reconnect anchor above)
  const already = table.seats.find((s) => String(s.user) === String(req.user._id));
  if (already) {
    return res.status(200).json({
      status: "success",
      message: "Reconnected to existing seat",
      data: {
        tableId: String(table._id),
        tableNumber: table.tableNumber,
        chips: already.chips ?? buyIn,
        reconnect: true,
        rtcRoom: { roomId: String(table._id), type: "table" },
      },
    });
  }

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

  // Atomic: lock funds + seat user (Tarneeb41 uses retry allocation)
  let joinedTableId = id;
  let joinMeta = { queued: false, queuePosition: 0, midHandJoin: false };
  try {
    if (table.gameType === "tarneeb41") {
      joinedTableId = await joinFixedCapacityWithRetry({
        gameType: "tarneeb41",
        userId: req.user._id,
        playerId: player._id,
        buyIn,
        initialTableId: id,
        tier: table.tier,
      });
    } else if (table.gameType === "trix") {
      joinedTableId = await joinFixedCapacityWithRetry({
        gameType: "trix",
        userId: req.user._id,
        playerId: player._id,
        buyIn,
        initialTableId: id,
        tier: table.tier,
      });
    } else if (table.gameType === "poker") {
      const preferQueue = req.body.preferQueue === true || req.body.preferQueue === "1";
      const clientIp = String(
        req.headers["x-forwarded-for"] || req.socket?.remoteAddress || ""
      );
      const deviceId = String(req.body?.deviceId || req.headers["x-device-id"] || "");
      const result = await joinPokerWithRetry({
        userId: req.user._id,
        playerId: player._id,
        buyIn,
        initialTableId: id,
        tier: table.tier,
        preferQueue,
        clientIp,
        deviceId: deviceId || null,
      });
      joinedTableId = result.tableId || String(result);
      joinMeta = {
        queued: !!result.queued,
        queuePosition: result.queuePosition || 0,
        midHandJoin: !!result.midHandJoin,
      };
    }
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("Insufficient wallet balance", 400);
    }
    if (e.message === "TABLE_NOT_FOUND") throw new ApiError("Table not found", 404);
    if (e.message === "TABLE_CLOSED") throw new ApiError("Table is closed", 400);
    if (e.message === "TABLE_FULL") throw new ApiError("Table is full", 400);
    if (e.message === "ALREADY_SEATED") throw new ApiError("You are already seated at this table", 400);
    if (e.message === "TABLE_CREATE_FAILED") {
      throw new ApiError("Could not allocate a table — try again", 503);
    }
    if (e.message === "INVALID_BUYIN") {
      throw new ApiError("Invalid buy-in for this table", 400);
    }
    if (e.message === "TABLE_CAPACITY_EXCEEDED") {
      throw new ApiError("Table is full", 400);
    }
    if (e.message === "ALREADY_QUEUED") {
      throw new ApiError("You are already in the waiting queue", 400);
    }
    if (e.message === "COLLUSION_IP") {
      throw new ApiError(
        "Cannot join this table: another seated player shares your network address",
        403
      );
    }
    if (e.message === "COLLUSION_DEVICE") {
      throw new ApiError(
        "Cannot join this table: another seated player shares your device",
        403
      );
    }
    throw e;
  }

  void trackJoinLeaveEvent(req.user._id, "join_table");
  trackEventServerFireAndForget(
    "user_join_table",
    req.user._id,
    { tableId: String(table._id), tier: table.tier, tableNumber: table.tableNumber },
    "server"
  );
  emitTablesUpdated({
    gameType: table.gameType || "poker",
    reason: "join",
    tableId: joinedTableId,
  });

  if (table.gameType === "poker") {
    void syncPokerTableStatusById(joinedTableId);
    if (!joinMeta.queued) {
      void syncLivePokerTableAfterJoin(joinedTableId);
    }
  }

  if (table.gameType === "tarneeb41") {
    void refreshTarneeb41GameSeats(joinedTableId);
  }

  if (table.gameType === "trix") {
    void refreshTrixGameSeats(joinedTableId);
  }

  const joinedTable = await Table.findById(joinedTableId).select(
    "tableNumber gameType tier waitingQueue seats"
  );

  if (joinMeta.queued) {
    const pos = await getQueuePosition(joinedTableId, req.user._id);
    return res.status(200).json({
      status: "success",
      message: "Added to waiting queue",
      data: {
        tableId: joinedTableId,
        tableNumber: joinedTable?.tableNumber ?? table.tableNumber,
        queued: true,
        queuePosition: pos > 0 ? pos : joinMeta.queuePosition,
      },
    });
  }

  res.status(200).json({
    status: "success",
    message: "Joined table successfully",
    data: {
      tableId: joinedTableId,
      tableNumber: joinedTable?.tableNumber ?? table.tableNumber,
      chips: buyIn,
      midHandJoin: joinMeta.midHandJoin,
      rtcRoom: { roomId: joinedTableId, type: "table" },
    },
  });
});

// Leave a table (protected)
exports.leaveTable = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const table = await Table.findById(id);
  if (!table) return next(new ApiError("Table not found", 404));

  const idx = table.seats.findIndex((s) => String(s.user) === String(req.user._id));
  const vacatingEntry =
    table.gameType === "poker"
      ? (table.vacatingPlayers || []).find(
          (v) => String(v.user) === String(req.user._id) && new Date(v.vacateUntil).getTime() > Date.now()
        )
      : null;

  if (idx === -1 && !vacatingEntry) {
    return next(new ApiError("You are not seated at this table", 400));
  }

  if (await isTableSettlementBlocked(id)) {
    return next(
      new ApiError("Settlement in progress — leaving is temporarily blocked", 409)
    );
  }

  const clientIp = String(
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || ""
  );
  const deviceId = String(req.body?.deviceId || req.headers["x-device-id"] || "");

  if (table.gameType === "poker") {
    const result = await vacatePokerSeat({
      tableId: id,
      userId: req.user._id,
      clientIp,
      deviceId: deviceId || null,
      reason: "leave",
    });
    if (!result.vacated) {
      if (result.reason === "NOT_SEATED") {
        return next(new ApiError("You are not seated at this table", 400));
      }
      return next(new ApiError("Could not leave table", 400));
    }

    const afterLeave = await Table.findById(id).select("seats gameType vacatingPlayers");
    if (
      afterLeave &&
      afterLeave.seats.length === 0 &&
      (!afterLeave.vacatingPlayers || afterLeave.vacatingPlayers.length === 0)
    ) {
      await resetPokerTableWhenEmpty(id);
    } else {
      await syncLivePokerTableAfterLeave(id);
      markTableActivity(String(id));
    }

    void trackJoinLeaveEvent(req.user._id, "leave_table");
    emitTablesUpdated({ gameType: "poker", reason: "vacate", tableId: String(id) });
    void syncPokerTableStatusById(String(id));

    return res.status(200).json({
      status: "success",
      message: "Seat vacated — return within 30 seconds or a bot takes your place",
      data: {
        vacated: true,
        chipsHeld: result.chips,
        vacateUntil: result.vacateUntil,
        vacateWindowMs: result.vacateWindowMs,
        rtcRoom: { roomId: table._id, type: "table" },
      },
    });
  }

  const chips = table.seats[idx].chips || 0;
  // Atomic: remove seat + unlock funds to balance
  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(id).session(session);
    if (!tableTx) throw new Error("TABLE_NOT_FOUND");

    const idxTx = tableTx.seats.findIndex((s) => String(s.user) === String(req.user._id));
    if (idxTx === -1) throw new Error("NOT_SEATED");
    const chipsTx = tableTx.seats[idxTx].chips || 0;

    tableTx.seats.splice(idxTx, 1);
    if (tableTx.gameType === "tarneeb41" && tableTx.seats.length < tableTx.capacity) {
      tableTx.status = "open";
    }
    if (tableTx.gameType === "poker") {
      tableTx.status = statusAfterSeatChange(tableTx, tableTx.seats.length);
    }
    await tableTx.save({ session });

    if (tableTx.gameType === "poker") {
      await seatNextFromQueue({ session, tableId: tableTx._id });
    }

    if (chipsTx > 0) {
      await releaseTableSeatToBalance({
        session,
        userId: req.user._id,
        seatChips: chipsTx,
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
    if (e.message === "INSUFFICIENT_TABLE_LOCKED_BALANCE") {
      throw new ApiError("Table locked balance inconsistency", 400);
    }
    throw e;
  });

  if (table.gameType === "poker") {
    await removeSeatPresence({
      tableId: id,
      userId: req.user._id,
      ip: clientIp,
      deviceId: deviceId || null,
    });

    const afterLeave = await Table.findById(id).select("seats gameType");
    if (afterLeave && afterLeave.seats.length === 0) {
      await resetPokerTableWhenEmpty(id);
    } else {
      await syncLivePokerTableAfterLeave(id);
      markTableActivity(String(id));
    }
  }

  void trackJoinLeaveEvent(req.user._id, "leave_table");
  emitTablesUpdated({ gameType: table.gameType || "poker", reason: "leave", tableId: String(id) });

  if (table.gameType === "poker") {
    void syncPokerTableStatusById(String(id));
  }

  if (table.gameType === "tarneeb41") {
    void refreshTarneeb41GameSeats(String(id));
  }

  res.status(200).json({
    status: "success",
    data: { cashedOut: chips, rtcRoom: { roomId: table._id, type: "table" } },
  });
});
