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
};

async function renderMetrics() {
  return client.register.metrics();
}

function contentType() {
  return client.register.contentType;
}

module.exports = { metrics, renderMetrics, contentType };

