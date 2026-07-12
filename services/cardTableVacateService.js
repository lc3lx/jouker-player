/**
 * Disconnect/leave grace for Tarneeb41 & Trix.
 * Trix (sole human): 30s then full table reset (refund + clear in-memory game).
 */
const Table = require("../models/tableModel");
const roomManager = require("../rooms/roomManager");
const logger = require("../utils/logger");
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
  return gameType === "trix" ? TRIX_VACATE_MS : VACATE_MS;
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
  if (!released) return false;
  emitTablesUpdated({
    gameType: "trix",
    reason: "vacate",
    tableId: String(tableId),
  });
  return true;
}

async function finalizeCardTableVacate({ gameType, tableId, userId, nsp }) {
  const game = getGame(gameType, tableId);
  const player = findHumanPlayer(game, userId);
  if (!player) {
    await abandonCardTableIfNoHumans(nsp, gameType, tableId);
    return;
  }

  if (isWithinVacateGrace(player)) {
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
  onCardTableRejoin,
  abandonCardTableIfNoHumans,
  isTrixVacateGraceReconnect,
  isWithinVacateGrace,
};
