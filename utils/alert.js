const logger = require("./logger");

/**
 * Lightweight production alerts: structured log + optional webhook.
 * @param {string} event
 * @param {Record<string, unknown>} fields
 */
async function sendAlert(event, fields = {}) {
  logger.warn("alert", { event, fields });

  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...fields,
      }),
    });
    if (!res.ok) {
      logger.error("alert_webhook_failed", { event, status: res.status });
    }
  } catch (e) {
    logger.error("alert_webhook_error", { event, reason: e?.message || "unknown" });
  }
}

module.exports = { sendAlert };
