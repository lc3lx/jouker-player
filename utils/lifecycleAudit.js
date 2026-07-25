const logger = require("./logger");

/**
 * Structured lifecycle audit trail.
 *
 * One consistent log shape for every session/table lifecycle transition so ops
 * and admin tooling can filter by `event`. Reuses the existing logger — this is
 * NOT a new product surface, just observability.
 *
 * event ∈ JOIN | LEAVE | DISCONNECT | RECONNECT | BOT_TAKEOVER | SHOWDOWN |
 *          SETTLEMENT | NEXT_HAND | ROUND_END | TABLE_RESET | RECOVERY | FROZEN
 *
 * fields (all optional): tableId, userId, gameType, handId | roundId,
 *          revision, frozenReason. A server `ts` is always stamped.
 */
function lifecycleAudit(event, fields = {}) {
  try {
    logger.info("lifecycle_audit", { event, ts: Date.now(), ...fields });
  } catch (_) {
    /* logging must never break the game loop */
  }
}

module.exports = { lifecycleAudit };
