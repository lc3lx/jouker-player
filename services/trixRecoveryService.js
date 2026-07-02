/**
 * Trix crash-recovery: pending settlements, stuck table locks, graceful refunds.
 */
const mongoose = require("mongoose");
const Table = require("../models/tableModel");
const GameSettlement = require("../models/gameSettlementModel");
const roomManager = require("../rooms/roomManager");
const logger = require("../utils/logger");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const {
  recoverPendingSettlement,
  settleGameOnFinish,
} = require("./gameSettlementService");
const {
  withMongoTransaction,
  releaseTableSeatToBalance,
} = require("./walletLedgerService");

/**
 * Destroy in-memory trix game and reopen Mongo table when no humans remain connected.
 * Refunds seated buy-ins if the game was abandoned mid-flight (no completed settlement).
 */
async function abandonTrixTableIfNoHumans(tableId) {
  const key = String(tableId);
  const game = roomManager.getTrixGameForTable(key);
  if (!game) {
    return { abandoned: false, reason: "no_game" };
  }

  // Humans still seated (including vacate grace before bot replacement / table reset).
  if (typeof game.humanCount === "function" && game.humanCount() > 0) {
    return { abandoned: false, reason: "humans_in_game" };
  }

  if (roomManager.countConnectedHumansAtTrixTable(key) > 0) {
    return { abandoned: false, reason: "humans_connected" };
  }

  let table = null;
  if (mongoose.Types.ObjectId.isValid(key)) {
    try {
      table = await Table.findById(key);
    } catch (err) {
      logger.warn("trix_abandon_table_lookup_failed", {
        tableId: key,
        reason: err?.message,
      });
    }
  }

  const needsRefund =
    table &&
    Array.isArray(table.seats) &&
    table.seats.length > 0 &&
    game.state !== "game_end" &&
    !game._settlementCompleted;

  if (needsRefund) {
    await refundTrixTableHumans(table, "trix_abandoned_refund");
  }

  const cleared = roomManager.clearTrixGame(key, { archiveReason: "abandoned" });
  if (cleared.cleared) {
    emitTablesUpdated({
      gameType: "trix",
      reason: "table_abandoned",
      tableId: key,
    });
  }

  return { abandoned: cleared.cleared, refunded: needsRefund, ...cleared };
}

async function markTrixTableOpen(tableId, session) {
  const q = Table.findByIdAndUpdate(
    tableId,
    { $set: { status: "open", activeSettlementId: null } },
    { new: true }
  );
  return session ? q.session(session) : q;
}

async function refundTrixTableHumans(tableDoc, reason = "settlement_recovery_refund") {
  if (!tableDoc?.seats?.length) return 0;
  let refunded = 0;
  await withMongoTransaction(async (session) => {
    const tableTx = await Table.findById(tableDoc._id).session(session);
    if (!tableTx) return;
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
      refunded += 1;
    }
    tableTx.seats = [];
    tableTx.status = "open";
    tableTx.activeSettlementId = null;
    await tableTx.save({ session });
  }).catch((err) => {
    logger.error("trix_refund_failed", {
      tableId: String(tableDoc._id),
      reason: err?.message,
    });
    throw err;
  });
  emitTablesUpdated({
    gameType: tableDoc.gameType || "trix",
    reason: "recovery_refund",
    tableId: String(tableDoc._id),
  });
  return refunded;
}

async function markCardTableOpen(gameType, tableId, session) {
  if (gameType === "trix") {
    return markTrixTableOpen(tableId, session);
  }
  const q = Table.findByIdAndUpdate(
    tableId,
    { $set: { status: "open", activeSettlementId: null } },
    { new: true }
  );
  return session ? q.session(session) : q;
}

/**
 * Retry pending settlements and unblock stuck tables after crash/restart.
 * @param {'trix'|'tarneeb41'} gameType
 */
async function recoverPendingCardGameSettlements(gameType) {
  let recovered = 0;
  let refunded = 0;
  let retried = 0;

  const pendingDocs = await GameSettlement.find({
    gameType,
    settlementStatus: "pending",
  })
    .sort({ createdAt: 1 })
    .lean();

  for (const doc of pendingDocs) {
    try {
      await recoverPendingSettlement(doc.settlementId);
      recovered += 1;
      await markCardTableOpen(gameType, doc.tableId);
      if (gameType === "trix") {
        roomManager.markTrixSettlementComplete(String(doc.tableId));
        roomManager.tryClearTrixGameIfReady(String(doc.tableId));
      } else {
        roomManager.markTarneeb41SettlementComplete(String(doc.tableId));
        roomManager.tryClearTarneeb41GameIfReady(String(doc.tableId));
      }
    } catch (err) {
      logger.error(`${gameType}_settlement_recovery_failed`, {
        settlementId: doc.settlementId,
        tableId: String(doc.tableId),
        reason: err?.message,
      });
    }
  }

  const lockedTables = await Table.find({
    gameType,
    activeSettlementId: { $ne: null },
  }).lean();

  for (const table of lockedTables) {
    const settlement = await GameSettlement.findOne({
      settlementId: table.activeSettlementId,
    }).lean();
    if (!settlement) {
      await Table.findByIdAndUpdate(table._id, { $set: { activeSettlementId: null } });
      continue;
    }
    if (settlement.settlementStatus === "pending") {
      try {
        await recoverPendingSettlement(settlement.settlementId);
        recovered += 1;
        await markCardTableOpen(gameType, table._id);
      } catch (err) {
        logger.error(`${gameType}_table_lock_recovery_failed`, {
          tableId: String(table._id),
          settlementId: settlement.settlementId,
          reason: err?.message,
        });
      }
    }
  }

  const stuckPlaying = await Table.find({
    gameType,
    status: "playing",
  }).lean();

  for (const table of stuckPlaying) {
    const tableId = String(table._id);
    const memGame =
      gameType === "trix"
        ? roomManager.getTrixGameForTable(tableId)
        : roomManager.getTarneeb41GameForTable(tableId);
    const hasLiveGame = memGame && memGame.state !== "game_end";

    if (hasLiveGame) continue;

    const latestFailed = await GameSettlement.findOne({
      tableId: table._id,
      gameType,
      settlementStatus: "failed",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (latestFailed?.gameResult) {
      try {
        const game = memGame || (gameType === "trix"
          ? roomManager.getTrixGameForTable(tableId)
          : roomManager.getTarneeb41GameForTable(tableId));
        await settleGameOnFinish({
          gameType,
          tableId: table._id,
          sessionId: latestFailed.sessionId,
          gameResult: latestFailed.gameResult,
          gamePlayers: game?.players,
        });
        retried += 1;
        await markCardTableOpen(gameType, table._id);
        continue;
      } catch (err) {
        logger.error(`${gameType}_settlement_retry_failed`, {
          tableId,
          reason: err?.message,
        });
      }
    }

    const completed = await GameSettlement.findOne({
      tableId: table._id,
      gameType,
      settlementStatus: "completed",
    })
      .sort({ createdAt: -1 })
      .lean();

    if (completed) {
      await markCardTableOpen(gameType, table._id);
      if (gameType === "trix") {
        roomManager.clearTrixGame(tableId);
      } else {
        roomManager.clearTarneeb41Game(tableId);
      }
      continue;
    }

    if (table.seats?.length > 0 && (latestFailed || table.activeSettlementId)) {
      try {
        const fullTable = await Table.findById(table._id);
        if (fullTable) {
          const n = await refundTrixTableHumans(
            fullTable,
            `${gameType}_crash_recovery_refund`
          );
          if (n > 0) refunded += n;
        }
        if (gameType === "trix") {
          roomManager.clearTrixGame(tableId);
        } else {
          roomManager.clearTarneeb41Game(tableId);
        }
      } catch (err) {
        logger.error(`${gameType}_stuck_table_refund_failed`, {
          tableId,
          reason: err?.message,
        });
      }
    }
  }

  if (gameType === "trix") {
    roomManager.evictExpiredTrixGames();
  } else {
    roomManager.evictExpiredTarneeb41Games();
  }

  if (recovered > 0 || refunded > 0 || retried > 0) {
    logger.info(`${gameType}_recovery_complete`, { recovered, refunded, retried });
  }

  return { recovered, refunded, retried };
}

async function recoverPendingTrixSettlements() {
  return recoverPendingCardGameSettlements("trix");
}

async function recoverPendingTarneeb41Settlements() {
  return recoverPendingCardGameSettlements("tarneeb41");
}

module.exports = {
  recoverPendingTrixSettlements,
  recoverPendingTarneeb41Settlements,
  recoverPendingCardGameSettlements,
  refundTrixTableHumans,
  markTrixTableOpen,
  abandonTrixTableIfNoHumans,
};
