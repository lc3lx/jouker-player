/**
 * Debug-mode NDJSON ingest (session 9f6022). Fold regions keep call sites clean.
 */
function agentDebugLog(hypothesisId, location, message, data = {}) {
  // #region agent log
  try {
    fetch("http://127.0.0.1:7937/ingest/b9a00eef-7143-4edb-b1d5-038072464bf7", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "9f6022",
      },
      body: JSON.stringify({
        sessionId: "9f6022",
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

module.exports = { agentDebugLog };
