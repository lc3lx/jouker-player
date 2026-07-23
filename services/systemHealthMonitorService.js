/**
 * Production monitoring + self-healing orchestrator. Periodically runs every
 * checker module in services/monitoring/, aggregates findings into a
 * per-subsystem + overall health score, logs every anomaly (auditService,
 * "monitor.*" event prefix — reusing the existing hash-chained audit log,
 * not a new store), and alerts (utils/alert.js#sendAlert — the existing
 * house-standard dispatcher) on every Critical finding, failed repair, and
 * any check that's been unhealthy for several consecutive sweeps in a row.
 *
 * Redis-leader-lock guarded (best-effort — see acquireLeadership) so a
 * multi-instance deployment doesn't run the sweep, and therefore the
 * repair actions, on every node at once. Every individual repair this
 * layer performs (adminForceEndHandTable, timerManager.clearAll,
 * releaseTableSeatToBalance, clanTournamentEngineService.tick) is already
 * safe to run redundantly, so failing open (running anyway) on a Redis
 * error or when Redis isn't configured is an acceptable, deliberate choice
 * — never block detection/alerting on lock acquisition.
 */
const crypto = require("crypto");
const logger = require("../utils/logger");
const { sendAlert } = require("../utils/alert");
const auditService = require("./auditService");
const { metrics } = require("../utils/metrics");
const settingsService = require("./systemMonitorSettingsService");

const tableHealthChecks = require("./monitoring/tableHealthChecks");
const economyHealthChecks = require("./monitoring/economyHealthChecks");
const tournamentHealthChecks = require("./monitoring/tournamentHealthChecks");
const socketHealthChecks = require("./monitoring/socketHealthChecks");
const processHealthChecks = require("./monitoring/processHealthChecks");

const LOCK_KEY = "monitor:leader";
const instanceId = crypto.randomUUID();

let redisClient = null;
let sweepTimer = null;
let lastSnapshot = null;
const consecutiveUnhealthy = new Map(); // check name -> consecutive sweep count

function setRedisClient(client) {
  redisClient = client;
}

async function acquireLeadership(ttlMs) {
  if (!redisClient) return true; // single-instance/dev — always leader
  try {
    const acquired = await redisClient.set(LOCK_KEY, instanceId, { NX: true, PX: ttlMs });
    if (acquired) return true;
    const current = await redisClient.get(LOCK_KEY);
    if (current === instanceId) {
      await redisClient.pExpire(LOCK_KEY, ttlMs);
      return true;
    }
    return false;
  } catch (e) {
    logger.warn("monitor_leadership_check_failed", { reason: e?.message || "unknown" });
    return true; // fail open — every repair action here is independently idempotent
  }
}

const SUBSYSTEMS = [
  { name: "tables", module: tableHealthChecks },
  { name: "economy", module: economyHealthChecks },
  { name: "tournaments", module: tournamentHealthChecks },
  { name: "sockets", module: socketHealthChecks },
  { name: "process", module: processHealthChecks },
];

function scoreFor(findings) {
  if (findings.some((f) => f.severity === "critical")) return { status: "critical", score: 20 };
  if (findings.some((f) => f.severity === "warning")) return { status: "warning", score: 60 };
  return { status: "healthy", score: 100 };
}

async function logFinding(finding, durationMs) {
  try {
    await auditService.logEvent({
      event: `monitor.${finding.check}`,
      table: finding.tableId,
      targetUser: finding.playerId,
      meta: {
        severity: finding.severity,
        message: finding.message,
        socketId: finding.socketId,
        repaired: finding.repaired,
        repairAction: finding.repairAction,
        repairResult: finding.repairResult,
        durationMs,
        ...finding.meta,
      },
    });
  } catch (e) {
    logger.warn("monitor_finding_log_failed", { check: finding.check, reason: e?.message });
  }

  metrics.monitorFindingsTotal.inc({ check: finding.check, severity: finding.severity });
  if (finding.repairAction) {
    metrics.monitorRepairsTotal.inc({ check: finding.check, result: finding.repairResult || "unknown" });
  }

  const shouldAlert = finding.severity === "critical" || finding.repairResult === "failed";
  if (shouldAlert) {
    void sendAlert(`monitor_${finding.check}`, {
      severity: finding.severity,
      tableId: finding.tableId,
      playerId: finding.playerId,
      message: finding.message,
      repaired: finding.repaired,
      repairAction: finding.repairAction,
      repairResult: finding.repairResult,
      ...finding.meta,
    });
  }
}

/** Runs one full sweep regardless of leadership — used by tests and the interval callback after acquiring the lock. */
async function runSweepOnce() {
  const settings = settingsService.getSettings();
  const sweepStart = Date.now();

  const results = await Promise.all(
    SUBSYSTEMS.map(async ({ name, module }) => {
      const start = Date.now();
      try {
        const { findings, stats } = await module.run(settings);
        return { name, findings, stats, durationMs: Date.now() - start, error: null };
      } catch (e) {
        logger.error("monitor_subsystem_failed", { subsystem: name, reason: e?.message || "unknown" });
        return { name, findings: [], stats: null, durationMs: Date.now() - start, error: e?.message || "unknown" };
      }
    })
  );

  const subsystems = {};
  let allFindings = [];
  for (const r of results) {
    const { status, score } = r.error
      ? { status: "critical", score: 20 }
      : scoreFor(r.findings);
    subsystems[r.name] = {
      status,
      score,
      findingCount: r.findings.length,
      findings: r.findings,
      stats: r.stats || null,
      durationMs: r.durationMs,
      error: r.error,
    };
    metrics.subsystemHealthScore.set({ subsystem: r.name }, score);
    allFindings = allFindings.concat(r.findings);
  }

  const overallScore = Math.round(
    Object.values(subsystems).reduce((s, x) => s + x.score, 0) / Object.values(subsystems).length
  );
  metrics.systemHealthScore.set(overallScore);

  // Repeated-anomaly tracking: per check name, across sweeps.
  const checksThisSweep = new Set(allFindings.map((f) => f.check));
  for (const check of checksThisSweep) consecutiveUnhealthy.set(check, (consecutiveUnhealthy.get(check) || 0) + 1);
  for (const check of [...consecutiveUnhealthy.keys()]) {
    if (!checksThisSweep.has(check)) consecutiveUnhealthy.delete(check);
  }

  await Promise.all(allFindings.map((f) => logFinding(f, Date.now() - sweepStart)));

  for (const check of checksThisSweep) {
    const streak = consecutiveUnhealthy.get(check) || 0;
    if (streak >= settings.repeatedAnomalyThreshold) {
      void sendAlert("monitor_repeated_anomaly", { check, consecutiveSweeps: streak });
    }
  }

  lastSnapshot = {
    at: new Date().toISOString(),
    overallScore,
    subsystems,
    totalFindings: allFindings.length,
    sweepDurationMs: Date.now() - sweepStart,
  };
  return lastSnapshot;
}

async function tick() {
  const settings = settingsService.getSettings();
  if (!settings.enabled) return;
  const isLeader = await acquireLeadership(Math.max(30000, settings.sweepIntervalMs * 2));
  if (!isLeader) return;
  try {
    await runSweepOnce();
  } catch (e) {
    logger.error("monitor_sweep_failed", { reason: e?.message || "unknown" });
  }
}

function startEngine({ intervalMs } = {}) {
  if (sweepTimer) return;
  const settings = settingsService.getSettings();
  const period = intervalMs || settings.sweepIntervalMs;
  sweepTimer = setInterval(() => {
    void tick();
  }, period);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  logger.info("system_health_monitor_started", { intervalMs: period });
}

function stopEngine() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function getSnapshot() {
  return lastSnapshot;
}

module.exports = {
  setRedisClient,
  startEngine,
  stopEngine,
  runSweepOnce,
  getSnapshot,
};
