const AnalyticsEvent = require("../models/analyticsEventModel");
const logger = require("../utils/logger");

/**
 * Server-side analytics (authoritative). Client may POST duplicates; treat as hints only.
 */
async function trackEventServer(name, userId, props = {}, source = "server") {
  if (!name || typeof name !== "string") return;
  try {
    await AnalyticsEvent.create({
      name,
      userId: userId || undefined,
      props: props && typeof props === "object" ? props : {},
      source,
    });
  } catch (e) {
    logger.warn("analytics_track_failed", { name, reason: e?.message || "unknown" });
  }
}

function trackEventServerFireAndForget(name, userId, props, source) {
  void trackEventServer(name, userId, props, source);
}

module.exports = {
  trackEventServer,
  trackEventServerFireAndForget,
};
