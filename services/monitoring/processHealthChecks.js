/**
 * Process/memory health checks: event-loop lag, heap/RSS usage, a rough CPU%
 * sample, and liveness of the two existing table-GC sweepers (staleness
 * signal only — this module never re-implements their cleanup logic).
 *
 * Uses Node's built-in perf_hooks.monitorEventLoopLag() — no new dependency,
 * and prom-client's collectDefaultMetrics() (utils/metrics.js) already
 * exposes the raw numbers passively; this module is what actually reads and
 * thresholds them into findings.
 */
const { monitorEventLoopDelay } = require("perf_hooks");
const { metrics } = require("../../utils/metrics");

function makeFinding({ check, severity, message, meta = {} }) {
  return {
    check,
    severity,
    tableId: null,
    playerId: null,
    socketId: null,
    message,
    meta,
    repaired: false,
    repairAction: null,
    repairResult: null,
  };
}

const lagHistogram = monitorEventLoopDelay({ resolution: 10 }); // 10ms resolution
lagHistogram.enable();

let lastCpuUsage = process.cpuUsage();
let lastCpuSampleAt = Date.now();

function checkEventLoopLag({ eventLoopLagWarningMs, eventLoopLagCriticalMs }) {
  const meanMs = lagHistogram.mean / 1e6;
  const maxMs = lagHistogram.max / 1e6;
  lagHistogram.reset();
  metrics.eventLoopLagMs.set(maxMs);

  const findings = [];
  if (maxMs >= eventLoopLagCriticalMs) {
    findings.push(
      makeFinding({
        check: "event_loop_lag",
        severity: "critical",
        message: `Event loop lag peaked at ${maxMs.toFixed(1)}ms (critical threshold ${eventLoopLagCriticalMs}ms)`,
        meta: { meanMs, maxMs },
      })
    );
  } else if (maxMs >= eventLoopLagWarningMs) {
    findings.push(
      makeFinding({
        check: "event_loop_lag",
        severity: "warning",
        message: `Event loop lag peaked at ${maxMs.toFixed(1)}ms (warning threshold ${eventLoopLagWarningMs}ms)`,
        meta: { meanMs, maxMs },
      })
    );
  }
  return { findings, meanMs, maxMs };
}

function checkMemory({ memoryWarningPct, memoryCriticalPct }) {
  const mem = process.memoryUsage();
  const heapPct = (mem.heapUsed / mem.heapTotal) * 100;

  const findings = [];
  if (heapPct >= memoryCriticalPct) {
    findings.push(
      makeFinding({
        check: "memory_usage",
        severity: "critical",
        message: `Heap usage at ${heapPct.toFixed(1)}% (critical threshold ${memoryCriticalPct}%)`,
        meta: mem,
      })
    );
  } else if (heapPct >= memoryWarningPct) {
    findings.push(
      makeFinding({
        check: "memory_usage",
        severity: "warning",
        message: `Heap usage at ${heapPct.toFixed(1)}% (warning threshold ${memoryWarningPct}%)`,
        meta: mem,
      })
    );
  }
  return { findings, memoryUsage: mem, heapPct };
}

function sampleCpu() {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpuUsage);
  const elapsedMs = Math.max(1, now - lastCpuSampleAt);
  lastCpuUsage = process.cpuUsage();
  lastCpuSampleAt = now;

  const totalCpuMicros = usage.user + usage.system;
  const cpuPct = (totalCpuMicros / 1000 / elapsedMs) * 100;
  return { cpuPct, userMs: usage.user / 1000, systemMs: usage.system / 1000 };
}

async function checkGcSweepLiveness() {
  const findings = [];
  const { getLastSweepAt: getCardLastSweep } = require("../tableGcService");
  const { getLastSweepAt: getPokerLastSweep } = require("../pokerTableGcService");

  const now = Date.now();
  const cardLast = getCardLastSweep();
  const pokerLast = getPokerLastSweep();

  // Neither sweeper has ever run — only worth flagging once both are past
  // their own default interval x2, otherwise this fires spuriously right
  // after boot before their first tick.
  if (cardLast != null && now - cardLast > 2 * 60000) {
    findings.push(
      makeFinding({
        check: "table_gc_stale",
        severity: "warning",
        message: `Card-game table GC sweep hasn't run in ${Math.round((now - cardLast) / 1000)}s`,
        meta: { lastSweepAt: cardLast },
      })
    );
  }
  if (pokerLast != null && now - pokerLast > 2 * 60000) {
    findings.push(
      makeFinding({
        check: "poker_table_gc_stale",
        severity: "warning",
        message: `Poker table GC sweep hasn't run in ${Math.round((now - pokerLast) / 1000)}s`,
        meta: { lastSweepAt: pokerLast },
      })
    );
  }
  return findings;
}

async function run(settings) {
  const lag = checkEventLoopLag(settings);
  const mem = checkMemory(settings);
  const cpu = sampleCpu();
  const gcLiveness = await checkGcSweepLiveness();

  return {
    findings: [...lag.findings, ...mem.findings, ...gcLiveness],
    stats: {
      eventLoopLagMeanMs: lag.meanMs,
      eventLoopLagMaxMs: lag.maxMs,
      memoryUsage: mem.memoryUsage,
      heapUsedPct: mem.heapPct,
      cpuPct: cpu.cpuPct,
      timerManagerSize: require("../../engine/TimerManager").size(),
    },
  };
}

module.exports = { run, checkEventLoopLag, checkMemory, sampleCpu, checkGcSweepLiveness };
