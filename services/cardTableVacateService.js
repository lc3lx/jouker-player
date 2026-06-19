/**
 * 30s disconnect/leave grace for Tarneeb41 & Trix — bot replacement then table clear.
 */
const Table = require("../models/tableModel");
const roomManager = require("../rooms/roomManager");
const logger = require("../utils/logger");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const { abandonTrixTableIfNoHumans } = require("./trixRecoveryService");

const VACATE_MS = Math.max(
  5000,
  parseInt(process.env.CARD_TABLE_VACATE_MS || "30000", 10)
);

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

  player.reconnectDeadline = Date.now() + VACATE_MS;
  player.socketId = null;

  const key = timerKey(gameType, tableId, userId);
  const timer = setTimeout(() => {
    vacateTimers.delete(key);
    void finalizeCardTableVacate({ gameType, tableId, userId, nsp });
  }, VACATE_MS);
  if (typeof timer.unref === "function") timer.unref();
  vacateTimers.set(key, timer);

  logger.info("card_table_vacate_scheduled", {
    gameType,
    tableId: String(tableId),
    userId: String(userId),
    vacateMs: VACATE_MS,
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

async function finalizeCardTableVacate({ gameType, tableId, userId, nsp }) {
  const game = getGame(gameType, tableId);
  const player = findHumanPlayer(game, userId);
  if (!player) {
    await abandonCardTableIfNoHumans(nsp, gameType, tableId);
    return;
  }

  if (player.reconnectDeadline && player.reconnectDeadline > Date.now()) {
    return;
  }

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
    roomManager.userToTarneeb41TableId.delete(String(userId));
    roomManager.tarneeb41UserSocket.delete(String(userId));
    if (typeof game.checkBotTurn === "function") game.checkBotTurn();
  } else {
    roomManager.userToTrixTableId.delete(String(userId));
    roomManager.trixUserSocket.delete(String(userId));
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
  cancelCardTableVacate({ gameType, tableId, userId });
}

module.exports = {
  VACATE_MS,
  scheduleCardTableVacate,
  cancelCardTableVacate,
  finalizeCardTableVacate,
  onCardTableRejoin,
  abandonCardTableIfNoHumans,
};
