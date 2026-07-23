const asyncHandler = require("express-async-handler");
const Table = require("../models/tableModel");
const WalletTransaction = require("../models/walletTransactionModel");
const TableLifecycleSettings = require("../models/tableLifecycleSettingsModel");
const tableLifecycleSettingsService = require("./tableLifecycleSettingsService");
const SystemMonitorSettings = require("../models/systemMonitorSettingsModel");
const systemMonitorSettingsService = require("./systemMonitorSettingsService");
const systemHealthMonitorService = require("./systemHealthMonitorService");
const {
  getTableGameDebugSnapshot,
  buildAdminRealtimeTablePayload,
  getLiveTableGameForAdmin,
  adminForceEndHandTable,
} = require("../sockets/tableGame");

exports.adminListTables = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  const tables = await Table.find({}, {
    _id: 1,
    gameType: 1,
    tier: 1,
    tableNumber: 1,
    status: 1,
    seats: 1,
    updatedAt: 1,
  }).limit(limit);

  const enriched = tables.map((t) => {
    const live = getTableGameDebugSnapshot(String(t._id));
    return {
      tableId: t._id,
      gameType: t.gameType,
      tier: t.tier,
      tableNumber: t.tableNumber,
      status: t.status,
      seated: t.seats.length,
      live,
    };
  });

  res.status(200).json({ status: "success", results: enriched.length, data: enriched });
});

exports.adminListPlayers = asyncHandler(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  const tables = await Table.find({}, { _id: 1, tableNumber: 1, seats: 1 }).limit(200);
  const players = [];
  for (const t of tables) {
    for (const s of t.seats || []) {
      players.push({
        userId: s.user,
        tableId: t._id,
        tableNumber: t.tableNumber,
        chips: s.chips,
        joinedAt: s.joinedAt,
      });
      if (players.length >= limit) break;
    }
    if (players.length >= limit) break;
  }
  res.status(200).json({ status: "success", results: players.length, data: players });
});

exports.adminListTransactions = asyncHandler(async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  const q = {};
  if (req.query.userId) q.userId = req.query.userId;
  if (req.query.tableId) q.tableId = req.query.tableId;
  if (req.query.handId) q.handId = req.query.handId;
  const rows = await WalletTransaction.find(q).sort({ createdAt: -1 }).limit(limit);
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminRealtimeTables = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  const tables = await Table.find(
    {},
    {
      _id: 1,
      gameType: 1,
      tier: 1,
      tableNumber: 1,
      status: 1,
      seats: 1,
      smallBlind: 1,
      bigBlind: 1,
      minBuyIn: 1,
      maxBuyIn: 1,
      updatedAt: 1,
    }
  ).limit(limit);

  const rows = await Promise.all(
    tables.map(async (t) => {
      const game = await getLiveTableGameForAdmin(String(t._id));
      const realtime = buildAdminRealtimeTablePayload(game);
      return {
        tableId: t._id,
        gameType: t.gameType,
        tier: t.tier,
        tableNumber: t.tableNumber,
        status: t.status,
        smallBlind: t.smallBlind,
        bigBlind: t.bigBlind,
        minBuyIn: t.minBuyIn,
        maxBuyIn: t.maxBuyIn,
        mongoSeated: (t.seats || []).length,
        mongoPlayers: (t.seats || []).map((s) => ({
          userId: s.user,
          chips: s.chips,
        })),
        realtime,
        liveSummary: getTableGameDebugSnapshot(String(t._id)),
      };
    })
  );

  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminForceEndHand = asyncHandler(async (req, res) => {
  const tableId = req.body?.tableId || req.query?.tableId;
  if (!tableId) {
    return res.status(400).json({ status: "error", message: "tableId is required" });
  }
  const result = await adminForceEndHandTable(String(tableId));
  res.status(200).json({ status: "success", data: result });
});

exports.adminGetTableLifecycleSettings = asyncHandler(async (req, res) => {
  const s = await TableLifecycleSettings.getDefaults();
  res.status(200).json({ status: "success", data: s });
});

const TABLE_LIFECYCLE_SETTING_KEYS = [
  "pokerReconnectWindowMs",
  "pokerVacateWindowMs",
  "pokerWaitForPlayersMs",
  "tarneeb41VacateMs",
  "trixVacateMs",
  "cardIdleTimeoutMs",
  "cardGcIntervalMs",
  "pokerEmptyGcMs",
  "pokerGcIntervalMs",
];

exports.adminUpdateTableLifecycleSettings = asyncHandler(async (req, res) => {
  const patch = req.body || {};
  const s = await TableLifecycleSettings.getDefaults();
  for (const k of TABLE_LIFECYCLE_SETTING_KEYS) {
    if (typeof patch[k] !== "undefined") s[k] = patch[k];
  }
  await s.save();
  // Applies immediately: reconnect/vacate windows are read from this cache
  // at the moment a timer is armed, not baked into a module-load constant.
  tableLifecycleSettingsService.applySettings(s.toObject());
  res.status(200).json({ status: "success", data: s });
});

/**
 * Table-lifecycle dashboard: status/kind breakdown, bot vs human seat
 * counts, live reconnect/vacate timers with remaining time, a ghost-seat
 * signal (SITTING_OUT past its own reconnect deadline — should be near-zero
 * now that the poker disconnect timeout hands off to the vacate pipeline
 * instead of stopping at SITTING_OUT), and process memory.
 */
exports.adminTableLifecycleOverview = asyncHandler(async (req, res) => {
  const now = Date.now();
  const limit = Math.min(300, Number(req.query.limit || 200));

  const tables = await Table.find(
    {},
    {
      _id: 1,
      gameType: 1,
      tier: 1,
      tableKind: 1,
      tableNumber: 1,
      status: 1,
      seats: 1,
      vacatingPlayers: 1,
      updatedAt: 1,
    }
  ).limit(limit);

  const byStatus = {};
  const byKind = {};
  let botSeats = 0;
  let humanSeats = 0;
  let activeReconnectTimers = 0;
  let activeVacateTimers = 0;
  let ghostSeats = 0;

  const rows = await Promise.all(
    tables.map(async (t) => {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      byKind[t.tableKind || "static"] = (byKind[t.tableKind || "static"] || 0) + 1;

      const live =
        t.gameType === "poker" ? buildAdminRealtimeTablePayload(await getLiveTableGameForAdmin(String(t._id))) : null;

      let tableBotSeats = 0;
      let tableHumanSeats = 0;
      let reconnectTimers = [];
      let ghostFlags = 0;

      if (live && Array.isArray(live.seats)) {
        for (const s of live.seats) {
          if (s.isBot) tableBotSeats += 1;
          else tableHumanSeats += 1;
          if (!s.isBot && s.reconnectDeadline) {
            const remainingMs = new Date(s.reconnectDeadline).getTime() - now;
            if (remainingMs > 0) {
              reconnectTimers.push({ userId: s.userId, remainingMs, kind: "reconnect" });
            } else if (s.playerState === "SITTING_OUT" || s.playerState === "sitting_out") {
              ghostFlags += 1;
            }
          }
        }
      } else {
        tableHumanSeats = (t.seats || []).length;
      }

      const vacateTimers = (t.vacatingPlayers || [])
        .filter((v) => new Date(v.vacateUntil).getTime() > now)
        .map((v) => ({
          userId: v.user,
          remainingMs: new Date(v.vacateUntil).getTime() - now,
          kind: "vacate",
        }));

      botSeats += tableBotSeats;
      humanSeats += tableHumanSeats;
      activeReconnectTimers += reconnectTimers.length;
      activeVacateTimers += vacateTimers.length;
      ghostSeats += ghostFlags;

      return {
        tableId: t._id,
        gameType: t.gameType,
        tier: t.tier,
        tableKind: t.tableKind || "static",
        tableNumber: t.tableNumber,
        status: t.status,
        humanSeats: tableHumanSeats,
        botSeats: tableBotSeats,
        timers: [...reconnectTimers, ...vacateTimers],
        ghostSeats: ghostFlags,
        updatedAt: t.updatedAt,
      };
    })
  );

  res.status(200).json({
    status: "success",
    data: {
      summary: {
        totalTables: tables.length,
        byStatus,
        byKind,
        botSeats,
        humanSeats,
        activeReconnectTimers,
        activeVacateTimers,
        ghostSeats,
        memoryUsage: process.memoryUsage(),
      },
      tables: rows,
    },
  });
});

/**
 * Production monitoring dashboard: the latest system-health-monitor sweep
 * snapshot (per-subsystem status/score, overall health %, and every finding
 * from the most recent pass). Triggers a fresh sweep on demand if none has
 * run yet (e.g. right after boot, before the first interval tick).
 */
exports.adminSystemHealth = asyncHandler(async (req, res) => {
  let snapshot = systemHealthMonitorService.getSnapshot();
  if (!snapshot) {
    snapshot = await systemHealthMonitorService.runSweepOnce();
  }
  res.status(200).json({ status: "success", data: snapshot });
});

exports.adminGetMonitorSettings = asyncHandler(async (req, res) => {
  const s = await SystemMonitorSettings.getDefaults();
  res.status(200).json({ status: "success", data: s });
});

const MONITOR_SETTING_KEYS = [
  "enabled",
  "sweepIntervalMs",
  "walletLockOrphanGraceMs",
  "stuckHandGraceMs",
  "tournamentMatchGraceMs",
  "repeatedAnomalyThreshold",
  "memoryWarningPct",
  "memoryCriticalPct",
  "eventLoopLagWarningMs",
  "eventLoopLagCriticalMs",
  "autoRepairEnabled",
];

exports.adminUpdateMonitorSettings = asyncHandler(async (req, res) => {
  const patch = req.body || {};
  const s = await SystemMonitorSettings.getDefaults();
  for (const k of MONITOR_SETTING_KEYS) {
    if (typeof patch[k] !== "undefined") s[k] = patch[k];
  }
  await s.save();
  systemMonitorSettingsService.applySettings(s.toObject());
  res.status(200).json({ status: "success", data: s });
});

