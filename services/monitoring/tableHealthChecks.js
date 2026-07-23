/**
 * Table health checks for the system monitor: duplicate seats/reservations,
 * dead poker game loops, orphaned TimerManager namespaces, and allocator
 * (fixed-tier static table) consistency.
 *
 * Every repair action reuses an existing, already-tested primitive
 * (adminForceEndHandTable, TimerManager.clearAll) — no new game logic here.
 */
const Table = require("../../models/tableModel");
const { LOBBY_EXCLUDED_STATUSES } = require("../tableLifecycleService");
const {
  getLiveTableGameForAdmin,
  listActivePokerTableIds,
  adminForceEndHandTable,
} = require("../../sockets/tableGame");
const roomManager = require("../../rooms/roomManager");
const timerManager = require("../../engine/TimerManager");
const { FIXED_TIER_TABLES } = require("../tableService");

function makeFinding({ check, severity, tableId = null, playerId = null, message, meta = {} }) {
  return {
    check,
    severity,
    tableId: tableId ? String(tableId) : null,
    playerId: playerId ? String(playerId) : null,
    socketId: null,
    message,
    meta,
    repaired: false,
    repairAction: null,
    repairResult: null,
  };
}

/**
 * Duplicate seat within one table, or a user present in more than one of
 * {seats, vacatingPlayers, waitingQueue} on the same table simultaneously.
 * Alert-only — which entry is authoritative is ambiguous, not safe to guess.
 */
async function checkDuplicateSeats() {
  const findings = [];
  const rows = await Table.aggregate([
    { $match: { status: { $nin: LOBBY_EXCLUDED_STATUSES } } },
    {
      $project: {
        gameType: 1,
        tier: 1,
        tableNumber: 1,
        seatUsers: { $map: { input: { $ifNull: ["$seats", []] }, as: "s", in: { $toString: "$$s.user" } } },
        vacatingUsers: {
          $map: { input: { $ifNull: ["$vacatingPlayers", []] }, as: "v", in: { $toString: "$$v.user" } },
        },
        queueUsers: {
          $map: { input: { $ifNull: ["$waitingQueue", []] }, as: "q", in: { $toString: "$$q.user" } },
        },
      },
    },
    {
      $addFields: {
        allUsers: { $concatArrays: ["$seatUsers", "$vacatingUsers", "$queueUsers"] },
      },
    },
    {
      $addFields: {
        distinctCount: { $size: { $setUnion: ["$allUsers", []] } },
        totalCount: { $size: "$allUsers" },
      },
    },
    { $match: { $expr: { $gt: ["$totalCount", "$distinctCount"] } } },
    { $limit: 200 },
  ]);

  for (const row of rows) {
    const seen = new Set();
    const dupes = new Set();
    for (const uid of row.allUsers) {
      if (seen.has(uid)) dupes.add(uid);
      seen.add(uid);
    }
    findings.push(
      makeFinding({
        check: "duplicate_seat_or_reservation",
        severity: "critical",
        tableId: row._id,
        playerId: [...dupes][0] || null,
        message: `User(s) ${[...dupes].join(",")} present more than once across seats/vacatingPlayers/waitingQueue on table ${row._id}`,
        meta: { gameType: row.gameType, tier: row.tier, tableNumber: row.tableNumber, duplicateUsers: [...dupes] },
      })
    );
  }
  return findings;
}

/**
 * Poker hand stuck: running with an expired actionDeadline and no timer
 * armed to progress it. Auto-repairs via the existing adminForceEndHandTable
 * (the same manual escape hatch admins already have).
 */
async function checkDeadGameLoops({ stuckHandGraceMs, autoRepairEnabled }) {
  const findings = [];
  const tableIds = listActivePokerTableIds();
  const now = Date.now();

  for (const tableId of tableIds) {
    const game = await getLiveTableGameForAdmin(tableId);
    if (!game || !game.running) continue;
    const deadline = game.actionDeadline;
    if (deadline == null || deadline > now - stuckHandGraceMs) continue;
    if (game.turnTimer || game.botThinkTimer) continue; // still progressing, not stuck

    const finding = makeFinding({
      check: "dead_game_loop",
      severity: "critical",
      tableId,
      message: `Poker table ${tableId} running with actionDeadline expired ${Math.round((now - deadline) / 1000)}s ago and no timer armed`,
      meta: { actionDeadline: deadline, round: game.round },
    });

    if (autoRepairEnabled) {
      const start = Date.now();
      try {
        const result = await adminForceEndHandTable(tableId);
        finding.repaired = !!result?.ok !== false;
        finding.repairAction = "adminForceEndHandTable";
        finding.repairResult = finding.repaired ? "success" : "failed";
        finding.meta.repairDurationMs = Date.now() - start;
        finding.meta.repairDetail = result;
      } catch (e) {
        finding.repaired = false;
        finding.repairAction = "adminForceEndHandTable";
        finding.repairResult = "failed";
        finding.meta.repairError = e?.message || "unknown";
      }
    }
    findings.push(finding);
  }
  return findings;
}

/**
 * TimerManager namespaces with live timers but no corresponding live game —
 * the class of leak the join_tarneeb41_table raw-Map-delete bug produced.
 * Auto-repairs by clearing the orphaned namespace (pure resource cleanup,
 * no money/gameplay state involved).
 */
async function checkOrphanTimerNamespaces({ autoRepairEnabled }) {
  const findings = [];
  const liveNamespaces = new Set();
  for (const game of roomManager.trixGamesByTableId.values()) {
    if (game?.roomId) liveNamespaces.add(game.roomId);
  }
  for (const game of roomManager.tarneeb41GamesByTableId.values()) {
    if (game?.roomId) liveNamespaces.add(game.roomId);
  }

  const allNamespaces = timerManager.listNamespaces();
  for (const namespace of allNamespaces) {
    // Only card-game namespaces follow the trix_table_*/tarneeb41_table_*
    // convention this check understands; anything else (poker uses its own
    // per-instance native timers, not TimerManager) is out of scope here.
    const isCardGameNamespace =
      namespace.startsWith("trix_table_") || namespace.startsWith("tarneeb41_table_");
    if (!isCardGameNamespace || liveNamespaces.has(namespace)) continue;

    const finding = makeFinding({
      check: "orphan_timer_namespace",
      severity: "warning",
      message: `TimerManager namespace "${namespace}" has live timers but no matching live game`,
      meta: { namespace, timerCount: timerManager.sizeForNamespace(namespace) },
    });

    if (autoRepairEnabled) {
      const cleared = timerManager.clearAll(namespace);
      finding.repaired = cleared > 0;
      finding.repairAction = "timerManager.clearAll";
      finding.repairResult = "success";
      finding.meta.clearedCount = cleared;
    }
    findings.push(finding);
  }
  return findings;
}

/**
 * Allocator/stake consistency: every fixed tier+buyIn combination has its
 * expected static tables, and no poker table above tableNumber 4 is
 * mismarked tableKind:"static" (the bug fixed in TABLE_LIFECYCLE_AUDIT.md —
 * this is the ongoing drift-detection layer in case it regresses).
 */
async function checkAllocatorConsistency() {
  const findings = [];

  for (const [tier, buyIns] of Object.entries(FIXED_TIER_TABLES)) {
    for (const gameType of ["poker", "trix", "tarneeb41"]) {
      const staticCount = await Table.countDocuments({
        gameType,
        tier,
        tableKind: "static",
        tableNumber: { $lte: 4 },
      });
      if (staticCount < 4) {
        findings.push(
          makeFinding({
            check: "allocator_missing_static_tables",
            severity: "warning",
            message: `Only ${staticCount}/4 static tables exist for ${gameType}/${tier}`,
            meta: { gameType, tier, expectedBuyIns: buyIns, staticCount },
          })
        );
      }
    }
  }

  const mismarked = await Table.countDocuments({
    tableNumber: { $gt: 4 },
    tableKind: { $nin: ["dynamic", "vip", "tournament"] },
  });
  if (mismarked > 0) {
    findings.push(
      makeFinding({
        check: "allocator_mismarked_overflow_tables",
        severity: "critical",
        message: `${mismarked} overflow table(s) (tableNumber>4) are not tableKind:dynamic/vip/tournament — will never be garbage-collected`,
        meta: { count: mismarked },
      })
    );
  }

  return findings;
}

async function run(settings) {
  const [duplicateSeats, deadLoops, orphanTimers, allocator] = await Promise.all([
    checkDuplicateSeats(),
    checkDeadGameLoops(settings),
    checkOrphanTimerNamespaces(settings),
    checkAllocatorConsistency(),
  ]);
  return { findings: [...duplicateSeats, ...deadLoops, ...orphanTimers, ...allocator] };
}

module.exports = { run, checkDuplicateSeats, checkDeadGameLoops, checkOrphanTimerNamespaces, checkAllocatorConsistency };
