/**
 * Debug-mode NDJSON ingest — OFF unless AGENT_DEBUG=1.
 * Keeps production/beta free of sync disk I/O and localhost fetch noise.
 */
const { isAgentDebugEnabled } = require("./agentDebugEnabled");

function agentDebugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  if (!isAgentDebugEnabled()) return;
  try {
    fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "4de1a0",
      },
      body: JSON.stringify({
        sessionId: "4de1a0",
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  } catch (_) {
    /* ignore */
  }
  // #endregion
}

function sessionDebugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  const payload = {
    sessionId: "7d1f00",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
    runId: "pre-fix",
  };
  try {
    const fs = require("fs");
    const path = require("path");
    fs.appendFileSync(
      path.join(__dirname, "..", "..", "debug-7d1f00.log"),
      `${JSON.stringify(payload)}\n`
    );
  } catch (_) {
    /* ignore */
  }
  try {
    fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "7d1f00",
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) {
    /* ignore */
  }
  // #endregion
}

module.exports = { agentDebugLog, sessionDebugLog };
