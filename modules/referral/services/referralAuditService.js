"use strict";

const ReferralAuditLog = require("../models/referralAuditLogModel");

async function append(entry) {
  if (!entry?.action) return null;
  return ReferralAuditLog.create({
    action: entry.action,
    referrerId: entry.referrerId || null,
    inviteeId: entry.inviteeId || null,
    tierId: entry.tierId || null,
    rewardId: entry.rewardId || null,
    actorId: entry.actorId || null,
    meta: entry.meta || {},
  });
}

async function list({ referrerId, inviteeId, action, page = 1, limit = 50 } = {}) {
  const q = {};
  if (referrerId) q.referrerId = referrerId;
  if (inviteeId) q.inviteeId = inviteeId;
  if (action) q.action = action;
  const skip = (Math.max(page, 1) - 1) * Math.min(limit, 100);
  const [rows, total] = await Promise.all([
    ReferralAuditLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 100)).lean(),
    ReferralAuditLog.countDocuments(q),
  ]);
  return { rows, total, page: Math.max(page, 1), limit: Math.min(limit, 100) };
}

module.exports = { append, list };
