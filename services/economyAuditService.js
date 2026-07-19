"use strict";

/**
 * Economy CMS audit trail. Every admin mutation records an immutable, hash-
 * chained entry via the platform's existing `auditService` (AuditLog collection),
 * with a standardized economy meta shape: admin, action, entity, old value, new
 * value, timestamp, IP, reason.
 *
 * Reusing auditService keeps a single tamper-evident chain across the platform
 * rather than a parallel, unchained economy log.
 */

const auditService = require("./auditService");
const AuditLog = require("../models/auditLogModel");

const EVENT_PREFIX = "economy.";

/** Pull the client IP from an Express request (proxy-aware). */
function ipFromReq(req) {
  if (!req) return null;
  return (
    (req.headers?.["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    null
  );
}

/** Build a portable actor context from an Express request. */
function actorFromReq(req) {
  return {
    id: req?.user?._id || null,
    name: req?.user?.name || null,
    ip: ipFromReq(req),
    userAgent: req?.headers?.["user-agent"] || null,
  };
}

/**
 * Record one economy admin action. Callable from a route (`req`) or from a
 * service with an explicit `actor` context, so audit is guaranteed on every
 * mutation regardless of the caller.
 * @param {object} p
 * @param {object} [p.req]       Express request (derives actor when `actor` omitted)
 * @param {object} [p.actor]     { id, name, ip, userAgent } — preferred, portable
 * @param {string} p.action      e.g. "update", "create", "publish", "bulk"
 * @param {string} p.entity      "item" | "currency" | "category" | "discount" | "season"
 * @param {string} [p.entityId]  affected id/key
 * @param {*} [p.before]         previous value snapshot
 * @param {*} [p.after]          new value snapshot
 * @param {string} [p.reason]    admin-supplied reason
 * @param {object} [p.extra]     extra meta (e.g. bulk count, filter)
 */
async function record({ req, actor, action, entity, entityId = null, before = null, after = null, reason = null, extra = {} }) {
  const who = actor || actorFromReq(req);
  return auditService.logEvent({
    event: `${EVENT_PREFIX}${entity}.${action}`,
    actor: who.id || null,
    ip: who.ip || null,
    userAgent: who.userAgent || null,
    meta: {
      admin: who.id ? String(who.id) : null,
      adminName: who.name || null,
      action,
      entity,
      entityId: entityId != null ? String(entityId) : null,
      before,
      after,
      reason: reason ? String(reason).slice(0, 500) : null,
      ...extra,
    },
  });
}

/**
 * Paginated economy audit-log query for the admin dashboard.
 * @param {{ entity?, action?, actor?, entityId?, page?, limit? }} q
 */
async function list(q = {}) {
  const page = Math.max(1, parseInt(q.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || "50", 10)));
  const filter = { event: { $regex: `^${EVENT_PREFIX}` } };
  if (q.entity) filter.event = { $regex: `^${EVENT_PREFIX}${q.entity}\\.` };
  if (q.action && q.entity) filter.event = `${EVENT_PREFIX}${q.entity}.${q.action}`;
  if (q.actor) filter.actor = q.actor;
  if (q.entityId) filter["meta.entityId"] = String(q.entityId);

  const [total, rows] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return { page, limit, total, pages: Math.ceil(total / limit), rows };
}

module.exports = { record, list, ipFromReq, actorFromReq, EVENT_PREFIX };
