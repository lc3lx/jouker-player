"use strict";

const ReferralProgress = require("../models/referralProgressModel");

/**
 * Atomically increment qualified count for a tier and optionally mark milestone ready.
 * @returns {Promise<{ matched: boolean, nextCount: number, becameReady: boolean }>}
 */
async function atomicIncrementQualifiedCount(referrerId, tierId, countKey, requiredCount) {
  const progress = await ReferralProgress.findOne({ referrerId })
    .select("qualifiedCounts milestoneStatus suspended blacklisted")
    .lean();
  if (!progress || progress.suspended || progress.blacklisted) {
    return { matched: false, nextCount: 0, becameReady: false };
  }

  const current =
    progress.qualifiedCounts?.[countKey] ??
    (progress.qualifiedCounts instanceof Map ? progress.qualifiedCounts.get(countKey) : 0) ??
    0;
  const nextCount = current + 1;
  const status =
    progress.milestoneStatus?.[tierId] ??
    (progress.milestoneStatus instanceof Map ? progress.milestoneStatus.get(tierId) : null) ??
    "open";

  const update = {
    $inc: { [`qualifiedCounts.${countKey}`]: 1 },
    $set: { lastUpdatedAt: new Date() },
  };

  let becameReady = false;
  if (status === "open" && nextCount >= requiredCount) {
    update.$set[`milestoneStatus.${tierId}`] = "ready";
    becameReady = true;
  }

  const result = await ReferralProgress.findOneAndUpdate(
    { referrerId, suspended: { $ne: true }, blacklisted: { $ne: true } },
    update,
    { new: true }
  );

  return {
    matched: !!result,
    nextCount: result ? nextCount : current,
    becameReady: !!result && becameReady,
  };
}

async function tryLockMilestoneForClaim(referrerId, tierId) {
  return ReferralProgress.findOneAndUpdate(
    {
      referrerId,
      suspended: { $ne: true },
      blacklisted: { $ne: true },
      [`milestoneStatus.${tierId}`]: "ready",
    },
    {
      $set: {
        [`milestoneStatus.${tierId}`]: "pending_review",
        lastUpdatedAt: new Date(),
      },
    },
    { new: true }
  );
}

async function releaseMilestoneClaimLock(referrerId, tierId, restoreStatus = "ready") {
  return ReferralProgress.findOneAndUpdate(
    {
      referrerId,
      [`milestoneStatus.${tierId}`]: "pending_review",
    },
    {
      $set: {
        [`milestoneStatus.${tierId}`]: restoreStatus,
        lastUpdatedAt: new Date(),
      },
    },
    { new: true }
  );
}

module.exports = {
  atomicIncrementQualifiedCount,
  tryLockMilestoneForClaim,
  releaseMilestoneClaimLock,
};
