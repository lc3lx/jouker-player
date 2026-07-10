"use strict";

const ApiError = require("../../../utils/apiError");
const WalletTransaction = require("../../../models/walletTransactionModel");
const ReferralRewardQueue = require("../models/referralRewardQueueModel");
const referralProgressService = require("./referralProgressService");
const referralAnalyticsService = require("./referralAnalyticsService");
const referralAuditService = require("./referralAuditService");
const progressRepository = require("../repositories/referralProgressRepository");
const fraudRiskService = require("../../fraud/services/fraudRiskService");
const {
  AUTO_APPROVE_MAX_RISK,
  MANUAL_REVIEW_MIN_RISK,
} = require("../../fraud/config/fraudSignalsConfig");
const { withMongoTransaction, ledgerDeposit } = require("../../../services/walletLedgerService");
const { applyMembershipChange } = require("../../../services/vipService");
const { createNotification } = require("../../../services/notificationService");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

async function payoutAlreadyExists(rewardId, userId) {
  return WalletTransaction.exists({
    userId,
    "meta.rewardId": String(rewardId),
  });
}

async function requestClaim(referrerId, tierId, clientSignals = {}) {
  const milestone = referralProgressService.getMilestone(tierId);
  if (!milestone) throw new ApiError("Invalid milestone tier", 400);

  const progress = await referralProgressService.getProgress(referrerId);
  if (progress.suspended) throw new ApiError("الإحالة معلّقة — تواصل مع الدعم", 403);
  if (progress.blacklisted) throw new ApiError("الحساب غير مؤهل للمكافآت", 403);

  const status = progress.milestoneStatus[tierId];
  if (status === "claimed") throw new ApiError("تم جمع هذه المكافأة مسبقاً", 400);
  if (status === "pending_review") throw new ApiError("المكافأة قيد المراجعة", 400);
  if (status !== "ready") throw new ApiError("لم تكتمل متطلبات هذه المرحلة بعد", 400);

  const locked = await progressRepository.tryLockMilestoneForClaim(referrerId, tierId);
  if (!locked) throw new ApiError("المكافأة قيد المعالجة أو غير جاهزة", 409);

  const fraud = await fraudRiskService.evaluateAndStore(referrerId, {
    userId: referrerId,
    action: "claim_reward",
    clientSignals,
  });

  let row;
  try {
    row = await ReferralRewardQueue.create({
      referrerId,
      tierId,
      status: "pending",
      rewardPayload: milestone.reward,
      fraudScoreAtClaim: fraud.score,
    });
  } catch (err) {
    await progressRepository.releaseMilestoneClaimLock(referrerId, tierId, "ready");
    if (err?.code !== 11000) throw err;
    const existing = await ReferralRewardQueue.findOne({ referrerId, tierId });
    if (!existing) throw err;
    if (existing.status === "completed") throw new ApiError("تم جمع هذه المكافأة مسبقاً", 400);
    if (existing.status === "pending" || existing.status === "processing") {
      throw new ApiError("المكافأة قيد المراجعة", 400);
    }
    if (existing.status === "rejected") {
      existing.status = "pending";
      existing.fraudScoreAtClaim = fraud.score;
      existing.rejectReason = "";
      await existing.save();
      row = existing;
    } else {
      throw new ApiError("المكافأة قيد المعالجة", 400);
    }
  }

  publish(Events.REFERRAL_REWARD_CLAIM_REQUESTED, {
    referrerId: String(referrerId),
    tierId,
    rewardId: String(row._id),
    fraudScore: fraud.score,
  });

  void referralAuditService.append({
    action: "reward_claim_requested",
    referrerId,
    tierId,
    rewardId: row._id,
    meta: { fraudScore: fraud.score },
  });

  const forceManual =
    fraud.score >= MANUAL_REVIEW_MIN_RISK || fraud.blacklisted || fraud.score > AUTO_APPROVE_MAX_RISK;

  if (!forceManual && fraud.score <= AUTO_APPROVE_MAX_RISK) {
    return approveReward(String(row._id), null, { auto: true });
  }

  return row;
}

async function approveReward(rewardId, reviewerId = null, { auto = false } = {}) {
  const row = await ReferralRewardQueue.findOneAndUpdate(
    { _id: rewardId, status: { $in: ["pending", "approved"] } },
    {
      $set: {
        status: "processing",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        autoApproved: auto,
      },
    },
    { new: true }
  );

  if (!row) {
    const existing = await ReferralRewardQueue.findById(rewardId);
    if (existing?.status === "completed") return existing;
    if (existing?.status === "processing") {
      throw new ApiError("Reward is already being processed", 409);
    }
    throw new ApiError("Reward not found or not approvable", 404);
  }

  void referralAuditService.append({
    action: "reward_approved",
    referrerId: row.referrerId,
    tierId: row.tierId,
    rewardId: row._id,
    actorId: reviewerId,
    meta: { auto },
  });

  const milestone = referralProgressService.getMilestone(row.tierId);
  if (!milestone) {
    await ReferralRewardQueue.updateOne(
      { _id: row._id, status: "processing" },
      { $set: { status: "pending" } }
    );
    await progressRepository.releaseMilestoneClaimLock(row.referrerId, row.tierId, "ready");
    throw new ApiError("Invalid tier on reward", 400);
  }

  const chips = milestone.reward?.chips || 0;
  let vipHistoryId = null;
  let walletCredited = false;

  try {
    const alreadyPaid = await payoutAlreadyExists(row._id, row.referrerId);

    if (chips > 0 && !alreadyPaid) {
      await withMongoTransaction(async (session) => {
        await ledgerDeposit({
          session,
          userId: row.referrerId,
          amount: chips,
          meta: {
            source: "referral_milestone",
            tierId: row.tierId,
            rewardId: String(row._id),
          },
          ledgerType: "referral_reward",
        });
      });
      walletCredited = true;
    } else if (alreadyPaid) {
      walletCredited = true;
    }

    if (milestone.reward?.vipLevel && !row.vipHistoryId) {
      const sub = await applyMembershipChange({
        userId: row.referrerId,
        level: milestone.reward.vipLevel,
        days: milestone.reward.vipDays || 7,
        kind: "admin_gift",
        provider: "admin",
        note: `referral_milestone:${row.tierId}`,
      });
      vipHistoryId = sub?._id ? String(sub._id) : null;
    }

    const completed = await ReferralRewardQueue.findOneAndUpdate(
      { _id: row._id, status: "processing" },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          walletTxMeta: { chips, rewardId: String(row._id), walletCredited },
          vipHistoryId: vipHistoryId || row.vipHistoryId || null,
        },
      },
      { new: true }
    );

    if (!completed) {
      throw new ApiError("Reward completion race — contact support", 409);
    }

    await referralProgressService.markTierClaimed(row.referrerId, row.tierId);
    await referralAnalyticsService.refreshAverages(row.referrerId);

    await createNotification({
      userId: row.referrerId,
      category: "bonus",
      title: "مكافأة دعوة الأصدقاء",
      subtitle: `حصلت على مكافأة ${milestone.title}`,
      icon: "gift",
      sourceType: "referral_milestone",
      sourceId: row.tierId,
    });

    publish(Events.REFERRAL_MILESTONE_COMPLETED, {
      referrerId: String(row.referrerId),
      tierId: row.tierId,
      chips,
      rewardId: String(row._id),
    });

    void referralAuditService.append({
      action: "reward_completed",
      referrerId: row.referrerId,
      tierId: row.tierId,
      rewardId: row._id,
      actorId: reviewerId,
      meta: { auto, chips, vipHistoryId, walletCredited },
    });

    return completed;
  } catch (err) {
    if (!walletCredited) {
      await ReferralRewardQueue.updateOne(
        { _id: row._id, status: "processing" },
        { $set: { status: "pending" } }
      );
      await progressRepository.releaseMilestoneClaimLock(row.referrerId, row.tierId, "ready");
    } else {
      await ReferralRewardQueue.updateOne(
        { _id: row._id, status: "processing" },
        {
          $set: {
            status: "completed",
            completedAt: new Date(),
            walletTxMeta: { chips, rewardId: String(row._id), walletCredited: true, partial: true },
          },
        }
      );
      await referralProgressService.markTierClaimed(row.referrerId, row.tierId);
    }
    throw err;
  }
}

async function rejectReward(rewardId, reviewerId, reason = "") {
  const row = await ReferralRewardQueue.findOneAndUpdate(
    { _id: rewardId, status: { $in: ["pending", "processing"] } },
    {
      $set: {
        status: "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        rejectReason: String(reason || "").slice(0, 500),
      },
    },
    { new: true }
  );
  if (!row) throw new ApiError("Reward not found or not rejectable", 404);

  await progressRepository.releaseMilestoneClaimLock(row.referrerId, row.tierId, "ready");

  void referralAuditService.append({
    action: "reward_rejected",
    referrerId: row.referrerId,
    tierId: row.tierId,
    rewardId: row._id,
    actorId: reviewerId,
    meta: { reason: row.rejectReason },
  });

  return row;
}

async function listRewards(filter = {}) {
  const q = {};
  if (filter.status) q.status = filter.status;
  if (filter.referrerId) q.referrerId = filter.referrerId;
  const page = Math.max(1, parseInt(filter.page || "1", 10));
  const limit = Math.min(100, parseInt(filter.limit || "20", 10));
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    ReferralRewardQueue.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ReferralRewardQueue.countDocuments(q),
  ]);
  return { rows, total, page, limit };
}

module.exports = {
  requestClaim,
  approveReward,
  rejectReward,
  listRewards,
};
