function log(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    fields,
  };
  // Structured JSON logging for observability pipelines.
  console.log(JSON.stringify(payload));
}

const logger = {
  debug(event, fields = {}) {
    log("debug", event, fields);
  },
  info(event, fields = {}) {
    log("info", event, fields);
  },
  warn(event, fields = {}) {
    log("warn", event, fields);
  },
  error(event, fields = {}) {
    log("error", event, fields);
  },
};

module.exports = logger;

