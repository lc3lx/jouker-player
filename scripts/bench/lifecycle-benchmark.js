/* eslint-disable no-console */
/**
 * Lifecycle benchmark harness — churn + steady-state profile for card tables.
 *
 * Drives a configurable fleet of clients (default profile: 1000 tables ×
 * 9 players ≈ 9000 sockets — override via env) against a STAGING server on the
 * `/game` namespace, then measures, from the CLIENT side:
 *   • connect latency  (connect → socket open)
 *   • time-to-first-state (join → first game_state)
 *   • revision throughput (game_state events/sec across the fleet)
 *   • churn resilience: repeated join→leave cycles to surface listener/timer
 *     leaks (watch the SERVER's process RSS + TimerManager.size() alongside).
 *
 * Server-side CPU / RAM / GC / Mongo / Redis / socket latency must be read from
 * the server's own metrics endpoint (this app already exposes Prometheus
 * metrics + the self-healing/monitoring dashboard) — a client harness cannot see
 * them. This script prints the client-observable numbers and a churn report so
 * you can correlate against server metrics during the run.
 *
 * NOT run in CI. Example:
 *   BENCH_URL=https://staging.example.com/game BENCH_GAME=trix \
 *   BENCH_TABLES=1000 BENCH_PER_TABLE=9 \
 *   BENCH_TABLE_IDS_FILE=./tableIds.txt BENCH_TOKENS_FILE=./tokens.txt \
 *   BENCH_DURATION_MS=180000 node scripts/bench/lifecycle-benchmark.js
 *
 * BENCH_TABLE_IDS_FILE / BENCH_TOKENS_FILE are newline-delimited. Tokens are
 * assigned round-robin across the fleet.
 */
const fs = require("fs");
const { io } = require("socket.io-client");

const URL = process.env.BENCH_URL || "http://localhost:8000/game";
const GAME = (process.env.BENCH_GAME || "trix").toLowerCase();
const TABLES = Math.max(1, Number(process.env.BENCH_TABLES || 1000));
const PER_TABLE = Math.max(1, Number(process.env.BENCH_PER_TABLE || 9));
const DURATION_MS = Math.max(30000, Number(process.env.BENCH_DURATION_MS || 180000));
const RAMP_MS = Math.max(0, Number(process.env.BENCH_RAMP_MS || 30000));
const CHURN_RATIO = Math.min(1, Math.max(0, Number(process.env.BENCH_CHURN_RATIO || 0.1)));

function readLines(envVar) {
  const p = process.env[envVar];
  if (!p) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

const TABLE_IDS = readLines("BENCH_TABLE_IDS_FILE");
const TOKENS = readLines("BENCH_TOKENS_FILE");

if (TABLE_IDS.length === 0 || TOKENS.length === 0) {
  console.error("Provide BENCH_TABLE_IDS_FILE and BENCH_TOKENS_FILE (newline-delimited).");
  process.exit(2);
}

const JOIN_EVENT = GAME === "tarneeb41" ? "join_tarneeb41_table" : "join_trix_table";

const metrics = {
  spawned: 0,
  connected: 0,
  firstStateCount: 0,
  connectLatencyMs: [],
  firstStateLatencyMs: [],
  stateEvents: 0,
  churnCycles: 0,
  errors: 0,
};

const sockets = [];

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function spawn(tableId, token, i) {
  const t0 = Date.now();
  let joinedAt = 0;
  let gotFirst = false;
  const sock = io(URL, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 250,
  });
  sockets.push({ sock, tableId });
  metrics.spawned += 1;

  sock.on("connect", () => {
    metrics.connected += 1;
    metrics.connectLatencyMs.push(Date.now() - t0);
    joinedAt = Date.now();
    sock.emit(JOIN_EVENT, { tableId });
  });
  sock.on("game_state", () => {
    metrics.stateEvents += 1;
    if (!gotFirst && joinedAt) {
      gotFirst = true;
      metrics.firstStateCount += 1;
      metrics.firstStateLatencyMs.push(Date.now() - joinedAt);
    }
  });
  sock.on("connect_error", () => { metrics.errors += 1; });
}

// Ramp the fleet up over RAMP_MS to avoid a thundering-herd artifact.
const total = TABLES * PER_TABLE;
let launched = 0;
const perTick = Math.max(1, Math.ceil(total / Math.max(1, RAMP_MS / 100)));
const rampTimer = setInterval(() => {
  for (let k = 0; k < perTick && launched < total; k += 1, launched += 1) {
    const tableId = TABLE_IDS[Math.floor(launched / PER_TABLE) % TABLE_IDS.length];
    const token = TOKENS[launched % TOKENS.length];
    spawn(tableId, token, launched);
  }
  if (launched >= total) clearInterval(rampTimer);
}, 100);

// Churn: recycle CHURN_RATIO of the fleet every 5s (leave → rejoin) to expose
// listener/timer leaks. Correlate with server RSS + TimerManager.size().
const churnTimer = setInterval(() => {
  const take = Math.max(1, Math.floor(sockets.length * CHURN_RATIO));
  for (let i = 0; i < take; i += 1) {
    const entry = sockets[Math.floor(Math.random() * sockets.length)];
    if (!entry?.sock) continue;
    try {
      entry.sock.emit("leave_room", { roomId: entry.tableId }, () => {});
      metrics.churnCycles += 1;
      setTimeout(() => {
        try {
          entry.sock.connect();
          entry.sock.emit(JOIN_EVENT, { tableId: entry.tableId });
        } catch (_) { /* noop */ }
      }, 500);
    } catch (_) { metrics.errors += 1; }
  }
}, 5000);

const reportTimer = setInterval(() => {
  console.log(JSON.stringify({
    t: new Date().toISOString(),
    spawned: metrics.spawned,
    connected: metrics.connected,
    stateEvents: metrics.stateEvents,
    churnCycles: metrics.churnCycles,
    errors: metrics.errors,
    connectP50: percentile(metrics.connectLatencyMs, 50),
    connectP95: percentile(metrics.connectLatencyMs, 95),
    firstStateP50: percentile(metrics.firstStateLatencyMs, 50),
    firstStateP95: percentile(metrics.firstStateLatencyMs, 95),
  }));
}, 5000);

setTimeout(() => {
  clearInterval(rampTimer);
  clearInterval(churnTimer);
  clearInterval(reportTimer);
  for (const { sock } of sockets) {
    try { sock.disconnect(); } catch (_) { /* noop */ }
  }
  console.log("\n=== Lifecycle benchmark summary ===");
  console.log(JSON.stringify({
    game: GAME,
    targetSockets: total,
    connected: metrics.connected,
    stateEventsTotal: metrics.stateEvents,
    stateEventsPerSec: Math.round(metrics.stateEvents / (DURATION_MS / 1000)),
    churnCycles: metrics.churnCycles,
    errors: metrics.errors,
    connect_ms: { p50: percentile(metrics.connectLatencyMs, 50), p95: percentile(metrics.connectLatencyMs, 95), p99: percentile(metrics.connectLatencyMs, 99) },
    firstState_ms: { p50: percentile(metrics.firstStateLatencyMs, 50), p95: percentile(metrics.firstStateLatencyMs, 95), p99: percentile(metrics.firstStateLatencyMs, 99) },
    note: "Read server CPU/RAM/GC/Mongo/Redis + TimerManager.size() from the server metrics endpoint during this run.",
  }, null, 2));
  setTimeout(() => process.exit(0), 500);
}, RAMP_MS + DURATION_MS);

console.log(`Benchmark ramping ${total} sockets over ${RAMP_MS}ms · ${GAME} · run ${DURATION_MS}ms → ${URL}`);
