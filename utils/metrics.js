const client = require("prom-client");

client.collectDefaultMetrics();

const metrics = {
  activePlayers: new client.Gauge({
    name: "poker_active_players",
    help: "Number of currently connected poker players",
  }),
  activeTables: new client.Gauge({
    name: "poker_active_tables",
    help: "Number of active in-memory poker tables",
  }),
  actionsTotal: new client.Counter({
    name: "poker_actions_total",
    help: "Total poker actions processed",
    labelNames: ["status", "action"],
  }),
  errorsTotal: new client.Counter({
    name: "poker_errors_total",
    help: "Total poker errors",
    labelNames: ["type"],
  }),
  suspiciousTotal: new client.Counter({
    name: "poker_suspicious_total",
    help: "Suspicious events count",
    labelNames: ["event"],
  }),
  systemHealthScore: new client.Gauge({
    name: "system_health_score",
    help: "Overall system health score from the monitoring sweep (0-100)",
  }),
  subsystemHealthScore: new client.Gauge({
    name: "subsystem_health_score",
    help: "Per-subsystem health score from the monitoring sweep (0-100)",
    labelNames: ["subsystem"],
  }),
  monitorFindingsTotal: new client.Counter({
    name: "monitor_findings_total",
    help: "Total anomalies found by the system health monitor",
    labelNames: ["check", "severity"],
  }),
  monitorRepairsTotal: new client.Counter({
    name: "monitor_repairs_total",
    help: "Total self-healing repair attempts by the system health monitor",
    labelNames: ["check", "result"],
  }),
  eventLoopLagMs: new client.Gauge({
    name: "event_loop_lag_ms",
    help: "Sampled Node.js event loop lag in milliseconds",
  }),
};

async function renderMetrics() {
  return client.register.metrics();
}

function contentType() {
  return client.register.contentType;
}

module.exports = { metrics, renderMetrics, contentType };

