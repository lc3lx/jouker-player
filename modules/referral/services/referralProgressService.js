"use strict";

const ReferralProgress = require("../models/referralProgressModel");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");
const progressRepository = require("../repositories/referralProgressRepository");
const {
  REFERRAL_MILESTONES,
  getMilestone,
  requirementsForMilestone,
  countKeyForMilestone,
} = require("../config/referralMilestonesConfig");
const qualificationEngine = require("../../qualification/services/qualificationEngine");
const referralAuditService = require("./referralAuditService");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

function readCount(progress, tierId) {
  if (progress.qualifiedCounts instanceof Map) {
    return progress.qualifiedCounts.get(tierId) || 0;
  }
  return progress.qualifiedCounts?.[tierId] || 0;
}

function setCount(progress, tierId, value) {
  if (progress.qualifiedCounts instanceof Map) {
    progress.qualifiedCounts.set(tierId, value);
  } else {
    progress.qualifiedCounts = progress.qualifiedCounts || {};
    progress.qualifiedCounts[tierId] = value;
  }
}

function readMilestoneStatus(progress, tierId) {
  return progress.milestoneStatus?.get?.(tierId) ?? progress.milestoneStatus?.[tierId] ?? "open";
}

function setMilestoneStatus(progress, tierId, status) {
  if (progress.milestoneStatus instanceof Map) {
    progress.milestoneStatus.set(tierId, status);
  } else {
    progress.milestoneStatus = progress.milestoneStatus || {};
    progress.milestoneStatus[tierId] = status;
  }
}

function defaultMilestoneStatus() {
  const map = {};
  for (const m of REFERRAL_MILESTONES) map[m.tierId] = "open";
  return map;
}

function defaultQualifiedCounts() {
  const map = new Map();
  for (const m of REFERRAL_MILESTONES) map.set(m.tierId, 0);
  return map;
}

async function ensureProgress(referrerId) {
  let row = await ReferralProgress.findOne({ referrerId });
  if (!row) {
    row = await ReferralProgress.create({
      referrerId,
      qualifiedCounts: defaultQualifiedCounts(),
      milestoneStatus: defaultMilestoneStatus(),
    });
  }
  return row;
}

async function getProgress(referrerId) {
  const row = await ensureProgress(referrerId);
  const milestoneStatus = {};
  for (const m of REFERRAL_MILESTONES) {
    milestoneStatus[m.tierId] = readMilestoneStatus(row, m.tierId);
  }
  return {
    referrerId: String(referrerId),
    qualifiedCounts: Object.fromEntries(
      REFERRAL_MILESTONES.map((m) => [m.tierId, readCount(row, m.tierId)])
    ),
    milestoneStatus,
    suspended: row.suspended === true,
    suspendedReason: row.suspendedReason || null,
    whitelisted: row.whitelisted === true,
    blacklisted: row.blacklisted === true,
    lastUpdatedAt: row.lastUpdatedAt,
    milestones: REFERRAL_MILESTONES.map((m) => ({
      ...m,
      currentCount: readCount(row, m.tierId),
      status: milestoneStatus[m.tierId] || "open",
    })),
  };
}

async function onInviteeQualified({ payload }) {
  const inviteeId = payload?.userId;
  const referredBy = payload?.snapshot?.referredBy || payload?.referredBy;
  if (!inviteeId || !referredBy) return;

  const achievementKey = payload?.achievementKey;
  const milestone = REFERRAL_MILESTONES.find((m) => m.qualificationKey === achievementKey);
  if (!milestone) return;

  const tierId = milestone.tierId;

  const snap = await ReferralInviteeSnapshot.findOneAndUpdate(
    {
      referrerId: referredBy,
      inviteeId,
      qualifiedTiers: { $ne: tierId },
    },
    { $addToSet: { qualifiedTiers: tierId } },
    { new: true }
  );
  if (!snap) return;

  const countKey = countKeyForMilestone(milestone);
  const { matched, nextCount, becameReady } = await progressRepository.atomicIncrementQualifiedCount(
    referredBy,
    tierId,
    countKey,
    milestone.requiredQualifiedCount
  );
  if (!matched) return;

  if (becameReady) {
    publish(Events.REFERRAL_MILESTONE_READY, {
      referrerId: String(referredBy),
      tierId,
    });
    void referralAuditService.append({
      action: "milestone_ready",
      referrerId: referredBy,
      inviteeId,
      tierId,
      meta: { count: nextCount, required: milestone.requiredQualifiedCount },
    });
  }

  void referralAuditService.append({
    action: "qualification_achieved",
    referrerId: referredBy,
    inviteeId,
    tierId,
    meta: { achievementKey },
  });
}

async function markTierClaimed(referrerId, tierId) {
  await ReferralProgress.findOneAndUpdate(
    { referrerId },
    {
      $set: {
        [`milestoneStatus.${tierId}`]: "claimed",
        lastUpdatedAt: new Date(),
      },
    }
  );
}

async function setMilestoneStatusForReferrer(referrerId, tierId, status) {
  await ReferralProgress.findOneAndUpdate(
    { referrerId },
    {
      $set: {
        [`milestoneStatus.${tierId}`]: status,
        lastUpdatedAt: new Date(),
      },
    }
  );
}

async function recalculateProgress(referrerId) {
  const invitees = await ReferralInviteeSnapshot.find({ referrerId });
  const progress = await ensureProgress(referrerId);

  for (const m of REFERRAL_MILESTONES) {
    setCount(progress, m.tierId, 0);
  }

  for (const snap of invitees) {
    const tiers = [];
    for (const milestone of REFERRAL_MILESTONES) {
      const evaluation = await qualificationEngine.evaluatePlayer(
        snap.inviteeId,
        requirementsForMilestone(milestone)
      );
      if (evaluation.qualified) {
        tiers.push(milestone.tierId);
        const countKey = countKeyForMilestone(milestone);
        setCount(progress, countKey, readCount(progress, countKey) + 1);
      }
    }
    snap.qualifiedTiers = tiers;
    await snap.save();
  }

  for (const milestone of REFERRAL_MILESTONES) {
    const countKey = countKeyForMilestone(milestone);
    const count = readCount(progress, countKey);
    const current = readMilestoneStatus(progress, milestone.tierId);
    if (current === "claimed") continue;
    const next = count >= milestone.requiredQualifiedCount ? "ready" : "open";
    setMilestoneStatus(progress, milestone.tierId, next);
  }

  progress.lastUpdatedAt = new Date();
  progress.markModified("qualifiedCounts");
  progress.markModified("milestoneStatus");
  await progress.save();

  void referralAuditService.append({
    action: "admin_recalculate",
    referrerId,
    meta: { inviteeCount: invitees.length },
  });

  return getProgress(referrerId);
}

module.exports = {
  ensureProgress,
  getProgress,
  onInviteeQualified,
  markTierClaimed,
  setMilestoneStatusForReferrer,
  recalculateProgress,
  getMilestone,
};
