const fraudService = require("./fraudService");
const auditService = require("./auditService");

/**
 * Aggregates risk signals into a 0–100 score.
 * Additive layer on top of existing fraudService.
 */
async function computeRiskScore(userId, { tableId = null, partnerUserId = null } = {}) {
  let score = 0;
  const factors = [];

  // Existing chip-dump evaluation is per-hand; risk score uses heuristics.
  if (partnerUserId) {
    factors.push({ type: "repeated_partnership", weight: 15 });
    score += 15;
  }

  // Placeholder hooks for device/IP correlation (extend pokerCollusionGuard data).
  factors.push({ type: "baseline_monitoring", weight: 5 });
  score += 5;

  const level = score >= 70 ? "high" : score >= 40 ? "medium" : "low";
  return { userId: String(userId), score, level, factors };
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

module.exports = {
  computeRiskScore,
  flagSuspiciousPartnership,
  evaluateHandChipDumpSuspect: fraudService.evaluateHandChipDumpSuspect,
};
