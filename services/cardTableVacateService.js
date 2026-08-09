/**
 * Disconnect/leave grace for Tarneeb41 & Trix.
 * Trix (sole human): 30s then full table reset (refund + clear in-memory game).
 */
const Table = require("../models/tableModel");
const roomManager = require("../rooms/roomManager");
const logger = require("../utils/logger");
const { lifecycleAudit } = require("../utils/lifecycleAudit");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const { abandonTrixTableIfNoHumans } = require("./trixRecoveryService");

const VACATE_MS = Math.max(
  5000,
  parseInt(process.env.CARD_TABLE_VACATE_MS || "60000", 10)
);

const TRIX_VACATE_MS = Math.max(
  5000,
  parseInt(
    process.env.TRIX_VACATE_MS ||
      process.env.CARD_TABLE_VACATE_MS ||
      "30000",
    10
  )
);

function vacateMsFor(gameType) {
  // Live-tunable via TableLifecycleSettings; falls back to the env-derived
  // constants above when no admin override has ever been saved.
  const { getSettings } = require("./tableLifecycleSettingsService");
  const s = getSettings();
  if (gameType === "trix") return s.trixVacateMs ?? TRIX_VACATE_MS;
  return s.tarneeb41VacateMs ?? VACATE_MS;
}

/** @type {Map<string, NodeJS.Timeout>} */
const vacateTimers = new Map();

function timerKey(gameType, tableId, userId) {
  return `${gameType}:${String(tableId)}:${String(userId)}`;
}

function getGame(gameType, tableId) {
  if (gameType === "tarneeb41") {
    return roomManager.getTarneeb41GameForTable(tableId);
  }
  if (gameType === "trix") {
    return roomManager.getTrixGameForTable(tableId);
  }
  return null;
}

function findHumanPlayer(game, userId) {
  if (!game || !Array.isArray(game.players)) return null;
  return game.players.find(
    (p) => !p.isBot && p.userId && String(p.userId) === String(userId)
  );
}

function isWithinVacateGrace(player) {
  return !!(
    player &&
    player.reconnectDeadline &&
    player.reconnectDeadline > Date.now()
  );
}

function cancelCardTableVacate({ gameType, tableId, userId }) {
  const key = timerKey(gameType, tableId, userId);
  const t = vacateTimers.get(key);
  if (t) {
    clearTimeout(t);
    vacateTimers.delete(key);
  }
  const game = getGame(gameType, tableId);
  const p = findHumanPlayer(game, userId);
  if (p) p.reconnectDeadline = null;
}

function scheduleCardTableVacate({ gameType, tableId, userId, nsp }) {
  if (gameType !== "tarneeb41" && gameType !== "trix") return;
  cancelCardTableVacate({ gameType, tableId, userId });

  const game = getGame(gameType, tableId);
  const player = findHumanPlayer(game, userId);
  if (!player) return;

  const vacateMs = vacateMsFor(gameType);
  player.reconnectDeadline = Date.now() + vacateMs;
  player.socketId = null;

  const key = timerKey(gameType, tableId, userId);
  const timer = setTimeout(() => {
    vacateTimers.delete(key);
    void finalizeCardTableVacate({ gameType, tableId, userId, nsp });
  }, vacateMs);
  if (typeof timer.unref === "function") timer.unref();
  vacateTimers.set(key, timer);

  logger.info("card_table_vacate_scheduled", {
    gameType,
    tableId: String(tableId),
    userId: String(userId),
    vacateMs,
    lastHuman: gameType === "trix" && game.humanCount() === 1,
  });

  try {
    const {
      broadcastTarneeb41TableState,
      broadcastTrixTableState,
    } = require("../socket/handlers/game.handlers");
    if (gameType === "tarneeb41") {
      broadcastTarneeb41TableState(nsp, tableId);
    } else {
      broadcastTrixTableState(nsp, tableId);
    }
  } catch (_) {
    // ignore broadcast errors during vacate schedule
  }
}

async function abandonTarneeb41IfNoHumans(tableId) {
  const key = String(tableId);
  const game = roomManager.getTarneeb41GameForTable(key);
  if (!game) return { abandoned: false, reason: "no_game" };
  if (typeof game.humanCount === "function" && game.humanCount() > 0) {
    return { abandoned: false, reason: "humans_in_game" };
  }

  const table = await Table.findById(key);
  const needsRefund =
    table &&
    Array.isArray(table.seats) &&
    table.seats.length > 0 &&
    game.state !== "game_end" &&
    !game._settlementCompleted;

  if (needsRefund) {
    const { refundTrixTableHumans } = require("./trixRecoveryService");
    try {
      await refundTrixTableHumans(table, "tarneeb41_abandoned_refund");
    } catch (err) {
      logger.error("tarneeb41_abandon_refund_failed", {
        tableId: key,
        reason: err?.message,
      });
    }
  }

  const cleared = roomManager.clearTarneeb41Game(key, { archiveReason: "abandoned" });
  if (cleared.cleared) {
    emitTablesUpdated({
      gameType: "tarneeb41",
      reason: "table_abandoned",
      tableId: key,
    });
  }
  return { abandoned: cleared.cleared, ...cleared };
}

async function abandonCardTableIfNoHumans(nsp, gameType, tableId) {
  const game = getGame(gameType, tableId);
  if (!game) return null;
  const humans =
    typeof game.humanCount === "function"
      ? game.humanCount()
      : game.players.filter((p) => !p.isBot).length;
  if (humans > 0) return { abandoned: false, reason: "humans_present" };

  if (gameType === "trix") {
    return abandonTrixTableIfNoHumans(tableId);
  }
  return abandonTarneeb41IfNoHumans(tableId);
}

async function releaseTrixMongoSeatOnVacate(tableId, userId) {
  const { withMongoTransaction, forfeitTableSeatLock } = require("./walletLedgerService");
  let released = false;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tableId).session(session);
    if (!table || table.gameType !== "trix") return;
    const idx = table.seats.findIndex(
      (s) => s.user && String(s.user) === String(userId)
    );
    if (idx === -1) return;
    const chips = Number(table.seats[idx].chips) || 0;
    table.seats.splice(idx, 1);
    if (table.seats.length < table.capacity) {
      table.status = "open";
    }
    // A bot plays on with these chips — the vacated player's wallet lock must be
    // forfeited here or it stays locked forever (settlement sees the seat as a bot).
    if (chips > 0) {
      await forfeitTableSeatLock({
        session,
        userId,
        tableId: table._id,
        seatChips: chips,
        meta: { reason: "trix_vacate_bot_takeover" },
      });
    }
    await table.save({ session });
    released = true;
  });
  // #region agent log
  const { agentDebugLog } = require("../utils/agentDebugLog");
  agentDebugLog("A", "cardTableVacateService.js:releaseTrixMongoSeat", "trix seat release result", {
    tableId: String(tableId),
    userId: String(userId),
    released,
  });
  // #endregion
  if (!released) return false;
  emitTablesUpdated({
    gameType: "trix",
    reason: "vacate",
    tableId: String(tableId),
  });
  return true;
}

async function finalizeCardTableVacate({ gameType, tableId, userId, nsp, intentional = false }) {
  const game = getGame(gameType, tableId);
  const player = findHumanPlayer(game, userId);
  // #region agent log
  const { agentDebugLog } = require("../utils/agentDebugLog");
  agentDebugLog("C", "cardTableVacateService.js:finalize", "finalizeCardTableVacate entry", {
    gameType,
    tableId: String(tableId),
    userId: String(userId),
    hasGame: !!game,
    hasHumanPlayer: !!player,
    withinGrace: !!player && isWithinVacateGrace(player),
    reconnectDeadline: player?.reconnectDeadline || null,
  });
  // #endregion
  if (!player) {
    await abandonCardTableIfNoHumans(nsp, gameType, tableId);
    return;
  }

  if (isWithinVacateGrace(player)) {
    // #region agent log
    agentDebugLog("C", "cardTableVacateService.js:finalize:grace", "finalize EARLY RETURN within grace", {
      gameType,
      tableId: String(tableId),
      userId: String(userId),
    });
    // #endregion
    return;
  }

  const wasLastTrixHuman =
    gameType === "trix" &&
    typeof game.humanCount === "function" &&
    game.humanCount() === 1;

  if (typeof game.convertHumanToBot === "function") {
    game.convertHumanToBot(userId);
  } else {
    player.isBot = true;
    player.userId = `bot_vacate_${Date.now()}_${player.seatIndex ?? 0}`;
    player.socketId = null;
    player.displayName = "بوت";
    player.reconnectDeadline = null;
  }

  if (gameType === "tarneeb41") {
    const seatIndex = player.seatIndex ?? 0;
    const seatChips = Number(player.chips) || 0;
    try {
      const { recordVacatedBotSeat, notifyBotSeatAvailable } = require("./tarneeb41BotSeatService");
      const table = await Table.findById(tableId).select("seats");
      const mongoSeat = table?.seats?.[seatIndex];
      const playerId =
        mongoSeat?.player ||
        (mongoSeat?.user && mongoSeat.user._id ? mongoSeat.user._id : mongoSeat?.user);
      await recordVacatedBotSeat({
        tableId,
        userId,
        seatIndex,
        chips: mongoSeat?.chips ?? seatChips,
        playerId,
        skipVacatingGrace: !!intentional,
      });
      await notifyBotSeatAvailable(nsp, tableId, seatIndex);
    } catch (err) {
      logger.warn("tarneeb41_vacate_record_failed", {
        tableId: String(tableId),
        reason: err?.message,
      });
    }
    roomManager.userToTarneeb41TableId.delete(String(userId));
    roomManager.tarneeb41UserSocket.delete(String(userId));
    if (typeof game.checkBotTurn === "function") game.checkBotTurn();
  } else {
    roomManager.userToTrixTableId.delete(String(userId));
    roomManager.trixUserSocket.delete(String(userId));

    if (wasLastTrixHuman) {
      if (typeof game.clearBotTimer === "function") game.clearBotTimer();
      if (typeof game.clearTurnTimer === "function") game.clearTurnTimer();
      logger.info("trix_last_human_vacate_reset", {
        tableId: String(tableId),
        userId: String(userId),
      });
      await abandonTrixTableIfNoHumans(tableId);
      return;
    }

    try {
      await releaseTrixMongoSeatOnVacate(tableId, userId);
    } catch (err) {
      logger.warn("trix_vacate_mongo_seat_release_failed", {
        tableId: String(tableId),
        userId: String(userId),
        reason: err?.message,
      });
    }
    if (typeof game.checkBotTurn === "function") game.checkBotTurn();
  }

  logger.info("card_table_vacate_bot_replaced", {
    gameType,
    tableId: String(tableId),
    userId: String(userId),
  });
  lifecycleAudit("BOT_TAKEOVER", {
    gameType,
    tableId: String(tableId),
    userId: String(userId),
  });

  if (game) {
    try {
      const {
        broadcastTarneeb41TableState,
        broadcastTrixTableState,
      } = require("../socket/handlers/game.handlers");
      if (gameType === "tarneeb41") {
        broadcastTarneeb41TableState(nsp, tableId);
      } else {
        broadcastTrixTableState(nsp, tableId);
      }
    } catch (_) {
      // ignore broadcast errors during vacate
    }
  }

  await abandonCardTableIfNoHumans(nsp, gameType, tableId);
}

/**
 * Intentional leave (no grace). Drops any pending vacate timer + reconnect
 * deadline, then finalizes immediately so the seat is converted to a bot (or the
 * table abandoned + refunded for the last human) and the OTHER players stop
 * seeing a ghost this instant. Disconnect keeps using scheduleCardTableVacate.
 * Idempotent: if the human is already gone, finalize no-ops / abandons.
 */
async function finalizeCardTableVacateNow({ gameType, tableId, userId, nsp }) {
  if (gameType !== "tarneeb41" && gameType !== "trix") return { freed: false };
  // cancel* nulls reconnectDeadline, so finalize won't early-return on grace.
  cancelCardTableVacate({ gameType, tableId, userId });
  await finalizeCardTableVacate({ gameType, tableId, userId, nsp, intentional: true });
  // Intentional leave has NO reconnect grace — purge any vacatingPlayers entry
  // so a stale grace record can never lock the player "active elsewhere".
  await purgeVacatingEntry(tableId, userId);
  // #region agent log
  try {
    const { agentDebugLog } = require("../utils/agentDebugLog");
    const after = await Table.findById(tableId).select("seats.user vacatingPlayers status");
    const stillSeated = (after?.seats || []).some(
      (s) => s.user && String(s.user) === String(userId)
    );
    agentDebugLog("LEAVE", "cardTableVacateService.js:finalizeNow", "intentional leave seat check", {
      gameType,
      tableId: String(tableId),
      userId: String(userId),
      stillSeated,
      status: after?.status || null,
    });
  } catch (_) {}
  // #endregion
  return { freed: true };
}

/**
 * Product rule: intentional leave ALWAYS frees the Mongo seat.
 * - Lobby / waiting / between rounds: cash-out chips to balance + splice seat.
 * - Mid-hand with other humans: bot takeover + forfeit lock + splice seat.
 * - Sole human (no other humans at table): full table reset — fresh deal on rejoin.
 * Caller must re-join via REST to sit again.
 */
async function intentionalLeaveCardTable({ gameType, tableId, userId, nsp }) {
  if (gameType !== "tarneeb41" && gameType !== "trix") {
    return { ok: false, reason: "not_card_game" };
  }
  const tid = String(tableId);
  const uid = String(userId);
  const game = getGame(gameType, tid);
  const liveHuman = findHumanPlayer(game, uid);
  const otherHumans = (game?.players || []).filter(
    (p) => !p.isBot && p.userId && String(p.userId) !== uid
  ).length;
  const midHand =
    !!liveHuman &&
    !!game?.state &&
    !["waiting", "countdown", "game_end"].includes(String(game.state));

  // #region agent log
  try {
    const { agentDebugLog } = require("../utils/agentDebugLog");
    agentDebugLog("H-reset1", "cardTableVacateService.js:intentionalLeave:entry", "intentional leave sole-human check", {
      gameType,
      tableId: tid,
      userId: uid,
      state: game?.state || null,
      midHand,
      otherHumans,
      humanCount: typeof game?.humanCount === "function" ? game.humanCount() : null,
      hasGameState: !!game?.gameState,
    });
  } catch (_) {}
  // #endregion

  // Sole human leaving → wipe the table (bots must not continue a ghost hand).
  if (otherHumans === 0 && game) {
    cancelCardTableVacate({ gameType, tableId: tid, userId: uid });
    if (liveHuman && typeof game.convertHumanToBot === "function") {
      try {
        game.convertHumanToBot(uid);
      } catch (_) {}
    }
    if (gameType === "trix") {
      roomManager.userToTrixTableId.delete(uid);
      roomManager.trixUserSocket.delete(uid);
    } else {
      roomManager.userToTarneeb41TableId.delete(uid);
      roomManager.tarneeb41UserSocket.delete(uid);
    }

    let abandonResult = null;
    if (gameType === "trix") {
      abandonResult = await abandonTrixTableIfNoHumans(tid);
      if (!abandonResult?.abandoned) {
        roomManager.clearTrixGame(tid, { archiveReason: "abandoned" });
        try {
          const { archiveTableDocument } = require("./tableLifecycleService");
          await archiveTableDocument(tid, { reason: "abandoned" });
        } catch (_) {}
        abandonResult = { abandoned: true, forced: true };
      }
    } else {
      abandonResult = await abandonTarneeb41IfNoHumans(tid);
      if (!abandonResult?.abandoned) {
        roomManager.clearTarneeb41Game(tid, { archiveReason: "abandoned" });
        try {
          const { archiveTableDocument } = require("./tableLifecycleService");
          await archiveTableDocument(tid, { reason: "abandoned" });
        } catch (_) {}
        abandonResult = { abandoned: true, forced: true };
      }
    }

    // #region agent log
    try {
      const { agentDebugLog } = require("../utils/agentDebugLog");
      const afterGame = getGame(gameType, tid);
      agentDebugLog("H-reset1", "cardTableVacateService.js:intentionalLeave:soleReset", "sole human leave reset", {
        gameType,
        tableId: tid,
        userId: uid,
        midHand,
        abandonResult,
        gameGone: !afterGame,
      });
    } catch (_) {}
    // #endregion

    emitTablesUpdated({ gameType, reason: "leave", tableId: tid });
    return {
      ok: true,
      mode: "last_human_reset",
      seatFreed: true,
      midHand,
      abandoned: true,
    };
  }

  if (midHand) {
    await finalizeCardTableVacateNow({ gameType, tableId: tid, userId: uid, nsp });
    // #region agent log
    try {
      const { agentDebugLog } = require("../utils/agentDebugLog");
      const after = await Table.findById(tid).select("seats.user vacatingPlayers");
      const stillSeated = (after?.seats || []).some(
        (s) => s.user && String(s.user) === uid
      );
      const vacatingActive = (after?.vacatingPlayers || []).some(
        (v) =>
          String(v.user) === uid &&
          v.vacateUntil &&
          new Date(v.vacateUntil).getTime() > Date.now()
      );
      agentDebugLog("H1", "cardTableVacateService.js:intentionalLeave", "mid-hand leave seat check", {
        gameType,
        tableId: tid,
        userId: uid,
        stillSeated,
        vacatingActive,
        mode: "mid_hand_bot_takeover",
        otherHumans,
      });
    } catch (_) {}
    // #endregion
    return { ok: true, mode: "mid_hand_bot_takeover", seatFreed: true };
  }

  // Not mid-hand: cash-out + hard-remove Mongo seat. Sync live lobby from Mongo
  // (do NOT convert to bot — that would keep a ghost seat in waiting).
  cancelCardTableVacate({ gameType, tableId: tid, userId: uid });
  const { withMongoTransaction, releaseTableSeatToBalance } = require("./walletLedgerService");
  let cashedOut = 0;
  await withMongoTransaction(async (session) => {
    const table = await Table.findById(tid).session(session);
    if (!table || table.gameType !== gameType) return;
    const idx = (table.seats || []).findIndex(
      (s) => s.user && String(s.user) === uid
    );
    if (idx >= 0) {
      cashedOut = Number(table.seats[idx].chips) || 0;
      table.seats.splice(idx, 1);
    }
    table.vacatingPlayers = (table.vacatingPlayers || []).filter(
      (v) => String(v.user) !== uid
    );
    if (table.seats.length < table.capacity) {
      table.status = "open";
    }
    await table.save({ session });
    if (cashedOut > 0) {
      await releaseTableSeatToBalance({
        session,
        userId: uid,
        tableId: tid,
        seatChips: cashedOut,
        meta: { reason: "intentional_leave_cashout", gameType },
      });
    }
  });

  if (gameType === "trix") {
    roomManager.userToTrixTableId.delete(uid);
    roomManager.trixUserSocket.delete(uid);
  } else {
    roomManager.userToTarneeb41TableId.delete(uid);
    roomManager.tarneeb41UserSocket.delete(uid);
  }

  try {
    const tableDoc = await Table.findById(tid).populate({
      path: "seats.user",
      select: "name country profileImg",
    });
    if (tableDoc && game) {
      if (gameType === "tarneeb41") {
        if (game.state === "countdown" && typeof game.cancelGameCountdown === "function") {
          game.cancelGameCountdown("seats_changed");
        }
        if (
          (game.state === "waiting" || game.state === "countdown") &&
          typeof game.syncLobbyFromTable === "function"
        ) {
          await game.syncLobbyFromTable(tableDoc, (id) =>
            roomManager.getTarneeb41UserSocket(String(id))
          );
        }
      } else if (
        game.state === "waiting" &&
        typeof game.syncLobbyFromTable === "function"
      ) {
        await game.syncLobbyFromTable(tableDoc, (id) =>
          roomManager.getTrixUserSocket(String(id))
        );
      }
    }
  } catch (_) {
    // Fallback: drop human from live roster if refresh unavailable.
    if (liveHuman && typeof game?.convertHumanToBot === "function") {
      try {
        game.convertHumanToBot(uid);
      } catch (_) {}
    }
  }

  emitTablesUpdated({ gameType, reason: "leave", tableId: tid });
  await abandonCardTableIfNoHumans(nsp, gameType, tid);

  // #region agent log
  try {
    const { agentDebugLog } = require("../utils/agentDebugLog");
    const after = await Table.findById(tid).select("seats.user vacatingPlayers");
    const stillSeated = (after?.seats || []).some(
      (s) => s.user && String(s.user) === uid
    );
    const vacatingActive = (after?.vacatingPlayers || []).some(
      (v) =>
        String(v.user) === uid &&
        v.vacateUntil &&
        new Date(v.vacateUntil).getTime() > Date.now()
    );
    agentDebugLog("H3", "cardTableVacateService.js:intentionalLeave", "cashout leave done", {
      gameType,
      tableId: tid,
      userId: uid,
      cashedOut,
      stillSeated,
      vacatingActive,
      midHand: false,
      otherHumans,
    });
  } catch (_) {}
  // #endregion

  return { ok: true, mode: "cashout", cashedOut, seatFreed: true, chipsReturned: cashedOut };
}

/**
 * Remove a user's reconnect-grace entry from a table (money already forfeited
 * on finalize, so this touches no wallet — it just clears the lock record).
 */
async function purgeVacatingEntry(tableId, userId) {
  try {
    await Table.updateOne(
      { _id: tableId },
      { $pull: { vacatingPlayers: { user: userId } } }
    );
  } catch (err) {
    logger.warn("card_vacating_entry_purge_failed", {
      tableId: String(tableId),
      userId: String(userId),
      reason: err?.message,
    });
  }
}

function onCardTableRejoin({ gameType, tableId, userId }) {
  const game = getGame(gameType, tableId);
  const player = findHumanPlayer(game, userId);
  if (!isWithinVacateGrace(player)) {
    return;
  }
  cancelCardTableVacate({ gameType, tableId, userId });
}

/**
 * True when a trix player may reconnect to an in-progress table (within vacate grace).
 */
function isTrixVacateGraceReconnect(game, userId) {
  if (!game) return false;
  const player = findHumanPlayer(game, userId);
  return isWithinVacateGrace(player);
}

module.exports = {
  VACATE_MS,
  TRIX_VACATE_MS,
  vacateMsFor,
  scheduleCardTableVacate,
  cancelCardTableVacate,
  finalizeCardTableVacate,
  finalizeCardTableVacateNow,
  intentionalLeaveCardTable,
  onCardTableRejoin,
  abandonCardTableIfNoHumans,
  isTrixVacateGraceReconnect,
  isWithinVacateGrace,
};
