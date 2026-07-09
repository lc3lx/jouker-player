"use strict";

const ReferralProgress = require("../models/referralProgressModel");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");
const {
  REFERRAL_MILESTONES,
  getMilestone,
  requirementsForMilestone,
  countKeyForMilestone,
} = require("../config/referralMilestonesConfig");
const qualificationEngine = require("../../qualification/services/qualificationEngine");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

function defaultMilestoneStatus() {
  const map = {};
  for (const m of REFERRAL_MILESTONES) map[m.tierId] = "open";
  return map;
}

async function ensureProgress(referrerId) {
  let row = await ReferralProgress.findOne({ referrerId });
  if (!row) {
    row = await ReferralProgress.create({
      referrerId,
      qualifiedCounts: { tier_5: 0, tier_15: 0, tier_25: 0, tier_30: 0 },
      milestoneStatus: defaultMilestoneStatus(),
    });
  }
  return row;
}

async function getProgress(referrerId) {
  const row = await ensureProgress(referrerId);
  const milestoneStatus = {};
  for (const m of REFERRAL_MILESTONES) {
    const raw = row.milestoneStatus?.get?.(m.tierId) ?? row.milestoneStatus?.[m.tierId];
    milestoneStatus[m.tierId] = raw || "open";
  }
  return {
    referrerId: String(referrerId),
    qualifiedCounts: row.qualifiedCounts || {},
    milestoneStatus,
    suspended: row.suspended === true,
    whitelisted: row.whitelisted === true,
    blacklisted: row.blacklisted === true,
    lastUpdatedAt: row.lastUpdatedAt,
    milestones: REFERRAL_MILESTONES.map((m) => ({
      ...m,
      currentCount: row.qualifiedCounts?.[countKeyForMilestone(m)] || 0,
      status: milestoneStatus[m.tierId] || "open",
    })),
  };
}

async function tryQualifyInviteeForTier(inviteeId, milestone) {
  const requirements = requirementsForMilestone(milestone);
  const key = milestone.qualificationKey;
  const result = await qualificationEngine.qualifyIfMet(inviteeId, key, requirements);
  return result.qualified ? milestone : null;
}

async function onInviteeQualified({ payload }) {
  const inviteeId = payload?.userId;
  const referredBy = payload?.snapshot?.referredBy || payload?.referredBy;
  if (!inviteeId || !referredBy) return;

  const snap = await ReferralInviteeSnapshot.findOne({
    referrerId: referredBy,
    inviteeId,
  });
  if (!snap) return;

  const progress = await ensureProgress(referredBy);
  if (progress.suspended || progress.blacklisted) return;

  let updated = false;

  for (const milestone of REFERRAL_MILESTONES) {
    if (snap.qualifiedTiers?.includes(milestone.tierId)) continue;

    const evaluation = await qualificationEngine.evaluatePlayer(
      inviteeId,
      requirementsForMilestone(milestone)
    );
    if (!evaluation.qualified) continue;

    snap.qualifiedTiers = snap.qualifiedTiers || [];
    snap.qualifiedTiers.push(milestone.tierId);
    await snap.save();

    const countKey = countKeyForMilestone(milestone);
    progress.qualifiedCounts[countKey] = (progress.qualifiedCounts[countKey] || 0) + 1;

    const status = progress.milestoneStatus?.get?.(milestone.tierId)
      ?? progress.milestoneStatus?.[milestone.tierId]
      ?? "open";

    if (
      status === "open" &&
      progress.qualifiedCounts[countKey] >= milestone.requiredQualifiedCount
    ) {
      if (progress.milestoneStatus instanceof Map) {
        progress.milestoneStatus.set(milestone.tierId, "ready");
      } else {
        progress.milestoneStatus[milestone.tierId] = "ready";
      }
      publish(Events.REFERRAL_MILESTONE_READY, {
        referrerId: String(referredBy),
        tierId: milestone.tierId,
      });
    }

    updated = true;
  }

  if (updated) {
    progress.lastUpdatedAt = new Date();
    progress.markModified("qualifiedCounts");
    progress.markModified("milestoneStatus");
    await progress.save();
  }
}

async function markTierClaimed(referrerId, tierId) {
  const progress = await ensureProgress(referrerId);
  if (progress.milestoneStatus instanceof Map) {
    progress.milestoneStatus.set(tierId, "claimed");
  } else {
    progress.milestoneStatus[tierId] = "claimed";
  }
  progress.markModified("milestoneStatus");
  await progress.save();
}

async function recalculateProgress(referrerId) {
  const invitees = await ReferralInviteeSnapshot.find({ referrerId }).lean();
  const progress = await ensureProgress(referrerId);
  progress.qualifiedCounts = { tier_5: 0, tier_15: 0, tier_25: 0, tier_30: 0 };

  for (const inv of invitees) {
    for (const milestone of REFERRAL_MILESTONES) {
      const evaluation = await qualificationEngine.evaluatePlayer(
        inv.inviteeId,
        requirementsForMilestone(milestone)
      );
      if (evaluation.qualified) {
        const countKey = countKeyForMilestone(milestone);
        progress.qualifiedCounts[countKey] = (progress.qualifiedCounts[countKey] || 0) + 1;
      }
    }
  }

  for (const milestone of REFERRAL_MILESTONES) {
    const countKey = countKeyForMilestone(milestone);
    const count = progress.qualifiedCounts[countKey] || 0;
    const current =
      progress.milestoneStatus?.get?.(milestone.tierId) ??
      progress.milestoneStatus?.[milestone.tierId] ??
      "open";
    if (current === "claimed") continue;
    const next = count >= milestone.requiredQualifiedCount ? "ready" : "open";
    if (progress.milestoneStatus instanceof Map) {
      progress.milestoneStatus.set(milestone.tierId, next);
    } else {
      progress.milestoneStatus[milestone.tierId] = next;
    }
  }

  progress.lastUpdatedAt = new Date();
  progress.markModified("qualifiedCounts");
  progress.markModified("milestoneStatus");
  await progress.save();
  return getProgress(referrerId);
}

module.exports = {
  ensureProgress,
  getProgress,
  onInviteeQualified,
  markTierClaimed,
  recalculateProgress,
  getMilestone,
};
