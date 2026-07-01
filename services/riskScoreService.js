const fraudService = require("./fraudService");
const auditService = require("./auditService");
const AuditLog = require("../models/auditLogModel");

const RISK_WEIGHTS = {
  chip_dumping: 25,
  soft_play: 20,
  ghosting: 15,
  collusion: 30,
  multi_account: 35,
  device_sharing: 20,
  same_ip_abuse: 25,
  vpn_abuse: 10,
  abnormal_betting: 15,
  repeated_partnership: 15,
};

async function countAuditFlags(userId, sinceDays = 30) {
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState !== 1) return {};
  try {
    const since = new Date(Date.now() - sinceDays * 86400000);
    const rows = await AuditLog.aggregate([
      {
        $match: {
          $or: [{ actor: userId }, { targetUser: userId }],
          createdAt: { $gte: since },
          event: { $in: ["risk_partnership_flagged", "fraud_flag", "admin_alert", "chip_dump_suspect"] },
        },
      },
      { $group: { _id: "$event", count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map((r) => [r._id, r.count]));
  } catch (_) {
    return {};
  }
}

/**
 * Aggregates risk signals into a 0–100 score with automatic flags.
 */
async function computeRiskScore(userId, { tableId = null, partnerUserId = null, handMeta = null } = {}) {
  let score = 0;
  const factors = [];
  const flags = [];

  if (partnerUserId) {
    factors.push({ type: "repeated_partnership", weight: RISK_WEIGHTS.repeated_partnership });
    score += RISK_WEIGHTS.repeated_partnership;
    flags.push("repeated_partnership");
  }

  const auditCounts = await countAuditFlags(userId);
  if (auditCounts.chip_dump_suspect) {
    factors.push({ type: "chip_dumping", weight: RISK_WEIGHTS.chip_dumping, count: auditCounts.chip_dump_suspect });
    score += RISK_WEIGHTS.chip_dumping;
    flags.push("chip_dumping");
  }
  if (auditCounts.fraud_flag) {
    factors.push({ type: "collusion", weight: RISK_WEIGHTS.collusion, count: auditCounts.fraud_flag });
    score += RISK_WEIGHTS.collusion;
    flags.push("collusion");
  }

  if (handMeta?.abnormalBetRatio > 3) {
    factors.push({ type: "abnormal_betting", weight: RISK_WEIGHTS.abnormal_betting });
    score += RISK_WEIGHTS.abnormal_betting;
    flags.push("abnormal_betting");
  }

  if (handMeta?.sameIpPartners > 2) {
    factors.push({ type: "same_ip_abuse", weight: RISK_WEIGHTS.same_ip_abuse });
    score += RISK_WEIGHTS.same_ip_abuse;
    flags.push("same_ip_abuse");
  }

  if (handMeta?.vpnDetected) {
    factors.push({ type: "vpn_abuse", weight: RISK_WEIGHTS.vpn_abuse });
    score += RISK_WEIGHTS.vpn_abuse;
    flags.push("vpn_abuse");
  }

  score = Math.min(100, score);
  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

  if (level === "high") {
    try {
      await auditService.logEvent({
        event: "admin_alert",
        actor: userId,
        table: tableId,
        meta: { riskScore: score, flags, level },
      });
    } catch (_) {
      /* audit optional in unit context */
    }
  }

  return { userId: String(userId), score, level, factors, flags, autoFlagged: level === "high" };
}

async function flagSuspiciousPartnership(userId, partnerUserId, meta = {}) {
  await auditService.logEvent({
    event: "risk_partnership_flagged",
    actor: userId,
    targetUser: partnerUserId,
    meta,
  });
  return computeRiskScore(userId, { partnerUserId });
}

async function evaluateHandRisk(handId, seats, actions) {
  const suspects = [];
  for (const seat of seats || []) {
    const uid = seat.user || seat.userId;
    if (!uid) continue;
    const dump = await fraudService.evaluateHandChipDumpSuspect?.({ handId, seats, actions, userId: uid });
    if (dump?.suspect) {
      await auditService.logEvent({
        event: "chip_dump_suspect",
        actor: uid,
        handId,
        meta: dump,
      });
      suspects.push({ userId: String(uid), reason: dump.reason });
    }
  }
  return suspects;
}

module.exports = {
  computeRiskScore,
  flagSuspiciousPartnership,
  evaluateHandRisk,
  evaluateHandChipDumpSuspect: fraudService.evaluateHandChipDumpSuspect,
  RISK_WEIGHTS,
};
