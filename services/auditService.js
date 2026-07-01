const crypto = require("crypto");

const AuditLog = require("../models/auditLogModel");

let lastHash = null;

function computeHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Append immutable audit event with hash chain.
 */
async function logEvent({
  event,
  actor = null,
  targetUser = null,
  table = null,
  handId = null,
  tournament = null,
  meta = null,
  ip = null,
  userAgent = null,
}) {
  const body = {
    event: String(event),
    actor,
    targetUser,
    table,
    handId,
    tournament,
    meta,
    ip,
    userAgent,
    prevHash: lastHash,
    ts: Date.now(),
  };
  const hash = computeHash(body);
  lastHash = hash;

  try {
    await AuditLog.create({
      event: body.event,
      actor: body.actor,
      targetUser: body.targetUser,
      table: body.table,
      handId: body.handId,
      tournament: body.tournament,
      meta: body.meta,
      ip: body.ip,
      userAgent: body.userAgent,
      prevHash: body.prevHash,
      hash,
    });
  } catch (e) {
    // Audit must never block gameplay.
    const logger = require("../utils/logger");
    logger.warn("audit_log_write_failed", { event, reason: e?.message });
  }
  return hash;
}

function buildHandAuditHash(handPayload) {
  const canonical = {
    handId: handPayload.handId,
    table: String(handPayload.table),
    gameType: handPayload.gameType || "poker",
    actions: handPayload.actions || [],
    community: handPayload.community || [],
    pot: handPayload.pot,
    rake: handPayload.rake,
    winners: handPayload.winners || [],
    seats: (handPayload.seats || []).map((s) => ({
      user: s.user ? String(s.user) : null,
      chipsBefore: s.chipsBefore,
      chipsAfter: s.chipsAfter,
      hole: s.hole,
    })),
    provablyFair: handPayload.provablyFair
      ? {
          serverSeedHash: handPayload.provablyFair.serverSeedHash,
          clientSeedDigest: handPayload.provablyFair.clientSeedDigest,
          handId: handPayload.provablyFair.handId,
        }
      : null,
  };
  return computeHash(canonical);
}

module.exports = { logEvent, buildHandAuditHash, computeHash };
