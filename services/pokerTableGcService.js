const Table = require("../models/tableModel");
const logger = require("../utils/logger");
const { emitTablesUpdated } = require("../utils/lobbyRealtime");
const pokerQueueRedis = require("../utils/redis/pokerQueueRedis");
const {
  getTableGameDebugSnapshot,
  evictTableFromRegistry,
  resetLivePokerTableWhenEmpty,
} = require("../sockets/tableGame");

const IDLE_MS = Math.max(
  60_000,
  parseInt(process.env.POKER_EMPTY_TABLE_GC_MS || "300000", 10)
);
const GC_INTERVAL_MS = Math.max(30_000, parseInt(process.env.POKER_GC_INTERVAL_MS || "60000", 10));

/** tableId -> firstSeenEmptyAt */
const emptySince = new Map();
let gcTimer = null;

function markTableActivity(tableId) {
  emptySince.delete(String(tableId));
}

async function countQueue(tableId) {
  if (pokerQueueRedis.isEnabled()) {
    return pokerQueueRedis.getQueueLength(tableId);
  }
  const t = await Table.findById(tableId).select("waitingQueue").lean();
  return Array.isArray(t?.waitingQueue) ? t.waitingQueue.length : 0;
}

/**
 * Immediate zero when last player leaves: engine pot/cards cleared, Redis snapshot removed.
 */
async function resetPokerTableWhenEmpty(tableId) {
  const tid = String(tableId);
  const table = await Table.findById(tid).select(
    "gameType seats tableNumber tier minBuyIn status waitingQueue vacatingPlayers"
  );
  if (!table || table.gameType !== "poker") return { reset: false, reason: "not_poker" };
  if (table.seats.length > 0) return { reset: false, reason: "not_empty" };
  const activeVacating = (table.vacatingPlayers || []).filter(
    (v) => v?.vacateUntil && new Date(v.vacateUntil).getTime() > Date.now()
  );
  if (activeVacating.length > 0) return { reset: false, reason: "vacating" };

  const qLen = await countQueue(tid);
  const live = getTableGameDebugSnapshot(tid);
  if (live?.running) {
    logger.warn("poker_table_reset_skipped_hand_active", { tableId: tid });
    return { reset: false, reason: "hand_active" };
  }

  await resetLivePokerTableWhenEmpty(tid);

  if (pokerQueueRedis.isEnabled() && qLen === 0) {
    await pokerQueueRedis.clearQueue(tid);
  }

  table.status = "waiting";
  if (Array.isArray(table.waitingQueue) && table.waitingQueue.length > 0 && qLen === 0) {
    table.waitingQueue = [];
  }
  if (Array.isArray(table.vacatingPlayers) && table.vacatingPlayers.length > 0) {
    table.vacatingPlayers = [];
  }
  await table.save();

  emptySince.delete(tid);

  if (qLen === 0 && table.tableNumber > 4) {
    await destroyEmptyTable(tid);
    return { reset: true, destroyed: true };
  }

  emitTablesUpdated({ gameType: "poker", reason: "table_reset_empty", tableId: tid });
  logger.info("poker_table_reset_empty", {
    tableId: tid,
    tableNumber: table.tableNumber,
    tier: table.tier,
  });
  return { reset: true, destroyed: false };
}

async function destroyEmptyTable(tableId) {
  const tid = String(tableId);
  const live = getTableGameDebugSnapshot(tid);
  if (live?.running) {
    markTableActivity(tid);
    return false;
  }

  const table = await Table.findById(tid).select(
    "gameType seats tableNumber tier minBuyIn status tableNumber"
  );
  if (!table || table.gameType !== "poker") return false;
  if (table.seats.length > 0) {
    markTableActivity(tid);
    return false;
  }

  const qLen = await countQueue(tid);
  if (qLen > 0) {
    markTableActivity(tid);
    return false;
  }

  if (table.tableNumber <= 4) {
    table.status = "waiting";
    await table.save();
    markTableActivity(tid);
    return false;
  }

  await evictTableFromRegistry(tid);
  if (pokerQueueRedis.isEnabled()) {
    await pokerQueueRedis.clearQueue(tid);
  }

  await Table.deleteOne({ _id: tid });
  emptySince.delete(tid);

  emitTablesUpdated({ gameType: "poker", reason: "table_gc_destroyed", tableId: tid });
  logger.info("poker_table_gc_destroyed", {
    tableId: tid,
    tier: table.tier,
    tableNumber: table.tableNumber,
  });
  return true;
}

async function gcSweep() {
  try {
    const candidates = await Table.find({
      gameType: "poker",
      status: { $in: ["waiting", "ready", "full"] },
      "seats.0": { $exists: false },
    })
      .select("_id tableNumber")
      .limit(200)
      .lean();

    const now = Date.now();
    for (const row of candidates) {
      const tid = String(row._id);
      const qLen = await countQueue(tid);
      if (qLen > 0) {
        markTableActivity(tid);
        continue;
      }

      const live = getTableGameDebugSnapshot(tid);
      if (live?.running) {
        markTableActivity(tid);
        continue;
      }

      if (!emptySince.has(tid)) {
        emptySince.set(tid, now);
        continue;
      }

      const since = emptySince.get(tid);
      if (now - since >= IDLE_MS) {
        await destroyEmptyTable(tid);
      }
    }
  } catch (e) {
    logger.error("poker_table_gc_sweep_failed", { reason: e?.message || "unknown" });
  }
}

function startPokerTableGc() {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    void gcSweep();
  }, GC_INTERVAL_MS);
  if (typeof gcTimer.unref === "function") gcTimer.unref();
  logger.info("poker_table_gc_started", { idleMs: IDLE_MS, intervalMs: GC_INTERVAL_MS });
}

function stopPokerTableGc() {
  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }
}

module.exports = {
  startPokerTableGc,
  stopPokerTableGc,
  markTableActivity,
  resetPokerTableWhenEmpty,
  destroyEmptyTable,
  gcSweep,
};
