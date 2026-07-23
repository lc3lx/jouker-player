/**
 * Server-boot zombie table sanitizer + runtime idle-table GC for card games and poker.
 *
 * Card games (tarneeb41 / trix) keep state in memory only — a restart leaves Mongo rows
 * in `playing` with no engine. Poker may restore from Redis; unrecoverable poker tables
 * are reset and seat locks are released atomically.
 */
const Table = require("../models/tableModel");
const GameSettlement = require("../models/gameSettlementModel");
const logger = require("../utils/logger");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const { RedisTableStateStore } = require("../utils/tableStateStore");
const roomManager = require("../rooms/roomManager");
const { archiveTableDocument } = require("./tableLifecycleService");
const {
  recoverPendingTrixSettlements,
  recoverPendingTarneeb41Settlements,
  refundTrixTableHumans,
} = require("./trixRecoveryService");
const {
  withMongoTransaction,
  releaseTableSeatToBalance,
} = require("./walletLedgerService");
const {
  abandonCardTableIfNoHumans,
  cancelCardTableVacate,
} = require("./cardTableVacateService");
const {
  getTableGameDebugSnapshot,
  adminForceEndHandTable,
  resetLivePokerTableWhenEmpty,
  evictTableFromRegistry,
} = require("../sockets/pokerTableGameBridge");

const CARD_GAME_TYPES = ["tarneeb41", "trix"];
const ZOMBIE_CARD_STATUSES = ["playing", "ready"];
const ZOMBIE_POKER_STATUSES = ["playing", "ready", "full"];

const TABLE_IDLE_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.TABLE_IDLE_TIMEOUT_MS || "900000", 10)  // Phase 2: 15 min for dynamic tables
);
const TABLE_GC_INTERVAL_MS = Math.max(
  30_000,
  parseInt(process.env.TABLE_GC_INTERVAL_MS || "60000", 10)
);
const POKER_RECOVERED_NO_SOCKETS_MS = Math.max(
  60_000,
  parseInt(process.env.POKER_RECOVERED_NO_SOCKETS_MS || "120000", 10)
);
const SANITIZE_OPEN_LOBBY_ON_BOOT =
  String(process.env.TABLE_BOOT_SANITIZE_OPEN_LOBBY || "false").toLowerCase() === "true";

/** tableId -> firstSeenWithZeroSocketsAt */
const cardIdleSince = new Map();
/** tableId -> { recoveredAt, noSocketsSince } */
const pokerRecoveryWatch = new Map();

let gcTimer = null;
let gameNsp = null;
let pokerNsp = null;
let redisClient = null;

function countSocketsInRoom(nsp, roomName) {
  if (!nsp?.adapter?.rooms) return 0;
  const room = nsp.adapter.rooms.get(roomName);
  return room ? room.size : 0;
}

function cardRoomName(gameType, tableId) {
  if (gameType === "tarneeb41") return `tarneeb41:${tableId}`;
  if (gameType === "trix") return `trix:${tableId}`;
  return null;
}

function countConnectedHumansCard(gameType, tableId) {
  if (gameType === "trix") {
    return roomManager.countConnectedHumansAtTrixTable(tableId);
  }
  if (gameType === "tarneeb41") {
    return roomManager.countConnectedHumansAtTarneeb41Table(tableId);
  }
  return 0;
}

function clearCardMemory(gameType, tableId) {
  const key = String(tableId);
  if (gameType === "trix") {
    roomManager.clearTrixGame(key, { archiveReason: "server_reboot" });
  } else if (gameType === "tarneeb41") {
    roomManager.clearTarneeb41Game(key, { archiveReason: "server_reboot" });
  }
}

async function reopenFixedCardTable(tableId, session) {
  const q = Table.findByIdAndUpdate(
    tableId,
    { $set: { status: "open", seats: [], activeSettlementId: null } },
    { new: true }
  );
  return session ? q.session(session) : q;
}

async function refundCardTableSeatsTransactional(tableDoc, reason) {
  if (!tableDoc?.seats?.length) return 0;
  return refundTrixTableHumans(tableDoc, reason);
}

async function refundPokerTableTransactional(tableDoc, reason) {
  let refunded = 0;
  // Redis-mode queue entries also hold locked buy-ins (transferToLocked at enqueue);
  // snapshot them before the queue is cleared so they can be refunded below.
  const pokerQueueRedis = require("../utils/redis/pokerQueueRedis");
  const redisQueueEntries = pokerQueueRedis.isEnabled()
    ? await pokerQueueRedis.listQueueEntries(String(tableDoc._id)).catch(() => [])
    : [];

  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(tableDoc._id).session(session);
    if (!tableTx) return;

    const refundedUsers = new Set();

    for (const seat of [...tableTx.seats]) {
      if (!seat.user) continue;
      const chips = Number(seat.chips) || 0;
      if (chips <= 0) continue;
      await releaseTableSeatToBalance({
        session,
        userId: seat.user,
        tableId: tableTx._id,
        seatChips: chips,
        meta: { reason, tableNumber: tableTx.tableNumber },
      });
      refundedUsers.add(String(seat.user));
      refunded += 1;
    }

    for (const vac of [...(tableTx.vacatingPlayers || [])]) {
      if (!vac.user) continue;
      const chips = Number(vac.chips) || 0;
      if (chips <= 0) continue;
      await releaseTableSeatToBalance({
        session,
        userId: vac.user,
        tableId: tableTx._id,
        seatChips: chips,
        meta: { reason: `${reason}_vacating`, tableNumber: tableTx.tableNumber },
      });
      refundedUsers.add(String(vac.user));
      refunded += 1;
    }

    // Queued players locked their buy-in at enqueue time — refund before clearing.
    const queueEntries = [
      ...(Array.isArray(tableTx.waitingQueue) ? tableTx.waitingQueue : []).map((q) => ({
        userId: q.user,
        buyIn: Number(q.buyIn) || 0,
      })),
      ...redisQueueEntries,
    ];
    for (const q of queueEntries) {
      if (!q.userId) continue;
      const uid = String(q.userId);
      if (refundedUsers.has(uid)) continue;
      const buyIn = Number(q.buyIn) || 0;
      if (buyIn <= 0) continue;
      await releaseTableSeatToBalance({
        session,
        userId: q.userId,
        tableId: tableTx._id,
        seatChips: buyIn,
        meta: { reason: `${reason}_queue`, tableNumber: tableTx.tableNumber },
      });
      refundedUsers.add(uid);
      refunded += 1;
    }

    tableTx.seats = [];
    tableTx.vacatingPlayers = [];
    tableTx.waitingQueue = [];
    tableTx.activeSettlementId = null;
    tableTx.status = tableTx.tableKind === "dynamic" ? "closed" : "waiting";
    await tableTx.save({ session });
  }).catch((err) => {
    logger.error("poker_boot_refund_failed", {
      tableId: String(tableDoc._id),
      reason: err?.message,
    });
    throw err;
  });

  if (redisQueueEntries.length > 0) {
    await pokerQueueRedis.clearQueue(String(tableDoc._id)).catch(() => {});
  }
  return refunded;
}

function logAbortedMatch({ gameType, tableId, reason, seatCount = 0 }) {
  logger.warn("table_match_aborted", {
    gameType,
    tableId: String(tableId),
    reason,
    seatCount,
    at: new Date().toISOString(),
  });
}

function isBootZombieCardTable(table) {
  const status = String(table?.status || "");
  const hasSettlementLock = !!table?.activeSettlementId;
  if (status === "open" && !hasSettlementLock && !SANITIZE_OPEN_LOBBY_ON_BOOT) {
    return false;
  }
  if (ZOMBIE_CARD_STATUSES.includes(status)) return true;
  return status === "open" && (hasSettlementLock || SANITIZE_OPEN_LOBBY_ON_BOOT);
}

/**
 * Boot-time cleanup for a single tarneeb41 / trix Mongo row with no live engine.
 */
async function sanitizeCardTableOnBoot(table) {
  const tableId = String(table._id);
  const gameType = table.gameType;
  const status = String(table.status || "");
  const hasSettlementLock = !!table.activeSettlementId;

  if (!CARD_GAME_TYPES.includes(gameType)) {
    return { tableId, action: "skipped", reason: "not_card_game" };
  }

  // Ephemeral clan-tournament match tables must never be reopened as a
  // normal bookable lobby table (the generic path below) — a crash mid-match
  // would otherwise leave a stale ClanTournamentMatch doc pointing at a table
  // that's silently back in the public lobby. Leave it untouched; the
  // tournament engine's own deadlineAt walkover sweep (already running,
  // idempotent) resolves and archives it once it starts ticking.
  if (table.tableKind === "tournament") {
    return { tableId, action: "skipped", reason: "tournament_match_deferred_to_engine" };
  }

  if (!isBootZombieCardTable(table)) {
    return { tableId, action: "skipped", reason: "open_lobby_preserved" };
  }

  const memGame =
    gameType === "trix"
      ? roomManager.getTrixGameForTable(tableId)
      : roomManager.getTarneeb41GameForTable(tableId);
  if (memGame && memGame.state !== "game_end") {
    return { tableId, action: "skipped", reason: "live_engine_present" };
  }

  const pending = await GameSettlement.findOne({
    tableId: table._id,
    gameType,
    settlementStatus: "pending",
  }).lean();
  if (pending) {
    return { tableId, action: "deferred", reason: "pending_settlement_recovery" };
  }

  let refunded = 0;
  const seatCount = Array.isArray(table.seats) ? table.seats.length : 0;

  if (seatCount > 0 && (status === "playing" || status === "ready" || SANITIZE_OPEN_LOBBY_ON_BOOT)) {
    const full = await Table.findById(table._id);
    if (full) {
      refunded = await refundCardTableSeatsTransactional(full, `${gameType}_boot_sanitizer_refund`);
      logAbortedMatch({
        gameType,
        tableId,
        reason: "server_reboot",
        seatCount,
      });
    }
  } else if (hasSettlementLock) {
    await Table.findByIdAndUpdate(tableId, { $set: { activeSettlementId: null } });
  }

  clearCardMemory(gameType, tableId);

  if (table.tableKind === "dynamic") {
    // Dynamic tables are ephemeral — delete from Mongo on boot cleanup.
    await Table.deleteOne({ _id: tableId });
    emitTablesUpdated({ gameType, reason: "table_removed", tableId });
    return { tableId, action: "deleted", refunded, seatCount };
  }

  await reopenFixedCardTable(tableId);
  emitTablesUpdated({ gameType, reason: "table_reopened", tableId });
  return { tableId, action: "reopened", refunded, seatCount };
}

/**
 * Boot-time cleanup for poker tables without a recoverable Redis snapshot.
 */
async function sanitizePokerTableOnBoot(table, redis) {
  const tableId = String(table._id);

  // Same rationale as sanitizeCardTableOnBoot: never let the generic
  // reset-to-"waiting" path touch an ephemeral clan-tournament poker match
  // table — defer to the tournament engine's own walkover sweep.
  if (table.tableKind === "tournament") {
    return { tableId, action: "skipped", reason: "tournament_match_deferred_to_engine" };
  }

  const stateStore = new RedisTableStateStore(redis);
  const snapshot = stateStore.isEnabled() ? await stateStore.load(tableId) : null;

  const handRecoverable =
    snapshot &&
    (snapshot.running === true ||
      (snapshot.round && String(snapshot.round) !== "idle"));

  if (handRecoverable) {
    pokerRecoveryWatch.set(tableId, {
      recoveredAt: Date.now(),
      noSocketsSince: null,
    });
    logger.info("poker_table_deferred_redis_recovery", { tableId });
    return { tableId, action: "deferred_redis_recovery" };
  }

  if (stateStore.isEnabled()) {
    await stateStore.delete(tableId);
  }

  const seatCount = Array.isArray(table.seats) ? table.seats.length : 0;
  let refunded = 0;
  if (seatCount > 0 || (table.vacatingPlayers || []).length > 0) {
    refunded = await refundPokerTableTransactional(table, "poker_boot_sanitizer_refund");
    logAbortedMatch({ gameType: "poker", tableId, reason: "server_reboot", seatCount });
  } else {
    await Table.findByIdAndUpdate(tableId, {
      $set: { status: "waiting", activeSettlementId: null },
    });
  }

  await evictTableFromRegistry(tableId);
  emitTablesUpdated({ gameType: "poker", reason: "table_reset_reboot", tableId });
  return { tableId, action: "reset", refunded, seatCount };
}

/**
 * Run before HTTP/Socket accept connections — clears zombie Mongo tables after crash/restart.
 */
async function runBootSanitizer({ redis = null } = {}) {
  const summary = {
    trixRecovery: null,
    tarneeb41Recovery: null,
    card: [],
    poker: [],
  };

  try {
    summary.trixRecovery = await recoverPendingTrixSettlements();
  } catch (err) {
    logger.error("boot_trix_recovery_failed", { reason: err?.message });
  }

  try {
    summary.tarneeb41Recovery = await recoverPendingTarneeb41Settlements();
  } catch (err) {
    logger.error("boot_tarneeb41_recovery_failed", { reason: err?.message });
  }

  const cardCandidates = await Table.find({
    gameType: { $in: CARD_GAME_TYPES },
    status: { $in: [...ZOMBIE_CARD_STATUSES, "open"] },
  })
    .limit(500)
    .lean();

  for (const table of cardCandidates) {
    try {
      const result = await sanitizeCardTableOnBoot(table);
      summary.card.push(result);
    } catch (err) {
      logger.error("boot_card_sanitize_failed", {
        tableId: String(table._id),
        reason: err?.message,
      });
      summary.card.push({
        tableId: String(table._id),
        action: "error",
        reason: err?.message,
      });
    }
  }

  const pokerCandidates = await Table.find({
    gameType: "poker",
    status: { $in: ZOMBIE_POKER_STATUSES },
  })
    .limit(500)
    .lean();

  for (const table of pokerCandidates) {
    try {
      const result = await sanitizePokerTableOnBoot(table, redis);
      summary.poker.push(result);
    } catch (err) {
      logger.error("boot_poker_sanitize_failed", {
        tableId: String(table._id),
        reason: err?.message,
      });
      summary.poker.push({
        tableId: String(table._id),
        action: "error",
        reason: err?.message,
      });
    }
  }

  logger.info("boot_sanitizer_complete", {
    cardSanitized: summary.card.filter((r) => r.action !== "skipped").length,
    pokerSanitized: summary.poker.filter((r) => r.action !== "skipped").length,
    trixRecovery: summary.trixRecovery,
    tarneeb41Recovery: summary.tarneeb41Recovery,
  });

  return summary;
}

async function forceCloseIdleCardTable(gameType, tableId) {
  const key = String(tableId);
  const game =
    gameType === "trix"
      ? roomManager.getTrixGameForTable(key)
      : roomManager.getTarneeb41GameForTable(key);
  if (!game) {
    cardIdleSince.delete(key);
    return { closed: false, reason: "no_game" };
  }

  if (game.state === "game_end" && game._settlementCompleted) {
    cardIdleSince.delete(key);
    return { closed: false, reason: "already_finished" };
  }

  // Phase 2: static tables are permanent — never idle-archive them.
  const tableDoc = await Table.findById(key).select("tableKind");
  if (tableDoc?.tableKind === "static") {
    cardIdleSince.delete(key);
    return { closed: false, reason: "static_table_exempt" };
  }
  // Tournament match tables have their own deadlineAt-driven walkover —
  // the generic idle-abandon path would archive them out from under a
  // still-"live" ClanTournamentMatch ahead of/independent from that.
  if (tableDoc?.tableKind === "tournament") {
    cardIdleSince.delete(key);
    return { closed: false, reason: "tournament_table_exempt" };
  }

  const humans = Array.isArray(game.players)
    ? game.players.filter((p) => !p.isBot && p.userId)
    : [];

  for (const p of humans) {
    cancelCardTableVacate({ gameType, tableId: key, userId: p.userId });
    if (typeof game.convertHumanToBot === "function") {
      game.convertHumanToBot(p.userId);
    } else {
      p.isBot = true;
      p.socketId = null;
    }
    if (gameType === "tarneeb41") {
      roomManager.userToTarneeb41TableId.delete(String(p.userId));
      roomManager.tarneeb41UserSocket.delete(String(p.userId));
    } else {
      roomManager.userToTrixTableId.delete(String(p.userId));
      roomManager.trixUserSocket.delete(String(p.userId));
    }
  }

  logAbortedMatch({
    gameType,
    tableId: key,
    reason: "idle_timeout_no_humans",
    seatCount: humans.length,
  });

  const result = await abandonCardTableIfNoHumans(gameNsp, gameType, key);
  cardIdleSince.delete(key);

  // Phase 2: delete dynamic tables from Mongo after abandon (abandon archives first, then we delete).
  if (result?.abandoned && tableDoc?.tableKind === "dynamic") {
    void Table.deleteOne({ _id: key }).catch(() => {});
    emitTablesUpdated({ gameType, reason: "table_removed", tableId: key });
  }

  return { closed: true, ...result };
}

async function sweepCardIdleTables() {
  if (!gameNsp) return;

  const now = Date.now();

  for (const gameType of CARD_GAME_TYPES) {
    const gamesMap =
      gameType === "trix"
        ? roomManager.trixGamesByTableId
        : roomManager.tarneeb41GamesByTableId;

    for (const [tableId, game] of gamesMap.entries()) {
      if (!game || game.state === "game_end") {
        cardIdleSince.delete(String(tableId));
        continue;
      }

      const connected = countConnectedHumansCard(gameType, tableId);
      const roomSockets = countSocketsInRoom(gameNsp, cardRoomName(gameType, tableId));
      const activeConnections = Math.max(connected, roomSockets);

      if (activeConnections > 0) {
        cardIdleSince.delete(String(tableId));
        continue;
      }

      const key = String(tableId);
      if (!cardIdleSince.has(key)) {
        cardIdleSince.set(key, now);
        continue;
      }

      const since = cardIdleSince.get(key);
      if (now - since >= TABLE_IDLE_TIMEOUT_MS) {
        try {
          await forceCloseIdleCardTable(gameType, key);
        } catch (err) {
          logger.error("card_idle_gc_failed", {
            gameType,
            tableId: key,
            reason: err?.message,
          });
        }
      }
    }
  }
}

async function sweepPokerRecoveredTables() {
  if (!pokerNsp || pokerRecoveryWatch.size === 0) return;

  const now = Date.now();
  for (const [tableId, watch] of [...pokerRecoveryWatch.entries()]) {
    const sockets = countSocketsInRoom(pokerNsp, `tg:${tableId}`);

    if (sockets > 0) {
      pokerRecoveryWatch.delete(tableId);
      continue;
    }

    if (watch.noSocketsSince == null) {
      watch.noSocketsSince = now;
      continue;
    }

    if (now - watch.noSocketsSince < POKER_RECOVERED_NO_SOCKETS_MS) {
      continue;
    }

    try {
      const live = getTableGameDebugSnapshot(tableId);
      if (live?.running) {
        await adminForceEndHandTable(tableId);
      }
      await resetLivePokerTableWhenEmpty(tableId);
      const table = await Table.findById(tableId).select("seats vacatingPlayers status");
      if (
        table &&
        table.seats.length === 0 &&
        (!table.vacatingPlayers || table.vacatingPlayers.length === 0)
      ) {
        pokerRecoveryWatch.delete(tableId);
        logAbortedMatch({
          gameType: "poker",
          tableId,
          reason: "redis_recovery_no_sockets",
        });
        continue;
      }

      if (table && (table.seats.length > 0 || (table.vacatingPlayers || []).length > 0)) {
        await refundPokerTableTransactional(table, "poker_recovery_abort_refund");
        await evictTableFromRegistry(tableId);
        const stateStore = new RedisTableStateStore(redisClient);
        if (stateStore.isEnabled()) {
          await stateStore.delete(tableId);
        }
      }

      pokerRecoveryWatch.delete(tableId);
      emitTablesUpdated({ gameType: "poker", reason: "recovery_aborted", tableId });
      logAbortedMatch({ gameType: "poker", tableId, reason: "redis_recovery_no_sockets" });
    } catch (err) {
      logger.error("poker_recovery_watch_failed", {
        tableId,
        reason: err?.message,
      });
    }
  }
}

let lastSweepAt = null;

async function gcSweep() {
  try {
    await sweepCardIdleTables();
  } catch (err) {
    logger.error("table_gc_card_sweep_failed", { reason: (err && err.message) || "unknown" });
  }
  try {
    await sweepPokerRecoveredTables();
  } catch (err) {
    logger.error("table_gc_poker_sweep_failed", { reason: (err && err.message) || "unknown" });
  }
  lastSweepAt = Date.now();
}

/** Diagnostic: when this sweep last completed (ms epoch), or null if never. */
function getLastSweepAt() {
  return lastSweepAt;
}

function startTableGc(io, { redis = null } = {}) {
  if (gcTimer) return;
  redisClient = redis || null;
  gameNsp = io.of("/game");
  pokerNsp = io.of("/table-game");
  gcTimer = setInterval(() => {
    void gcSweep();
  }, TABLE_GC_INTERVAL_MS);
  if (typeof gcTimer.unref === "function") gcTimer.unref();
  logger.info("table_gc_started", {
    idleTimeoutMs: TABLE_IDLE_TIMEOUT_MS,
    intervalMs: TABLE_GC_INTERVAL_MS,
    pokerRecoveredNoSocketsMs: POKER_RECOVERED_NO_SOCKETS_MS,
    redisEnabled: !!redis,
  });
}

function stopTableGc() {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
  cardIdleSince.clear();
  pokerRecoveryWatch.clear();
}

function registerPokerRecoveryWatch(tableId) {
  pokerRecoveryWatch.set(String(tableId), {
    recoveredAt: Date.now(),
    noSocketsSince: null,
  });
}

module.exports = {
  runBootSanitizer,
  startTableGc,
  stopTableGc,
  sanitizeCardTableOnBoot,
  isBootZombieCardTable,
  sanitizePokerTableOnBoot,
  gcSweep,
  registerPokerRecoveryWatch,
  TABLE_IDLE_TIMEOUT_MS,
  POKER_RECOVERED_NO_SOCKETS_MS,
  countSocketsInRoom,
  cardRoomName,
  getLastSweepAt,
};
