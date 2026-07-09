"use strict";

const ApiError = require("../../../utils/apiError");
const ReferralRewardQueue = require("../models/referralRewardQueueModel");
const referralProgressService = require("./referralProgressService");
const referralAnalyticsService = require("./referralAnalyticsService");
const fraudRiskService = require("../../fraud/services/fraudRiskService");
const { AUTO_APPROVE_MAX_RISK } = require("../../fraud/config/fraudSignalsConfig");
const { withMongoTransaction, ledgerDeposit } = require("../../../services/walletLedgerService");
const { applyMembershipChange } = require("../../../services/vipService");
const { createNotification } = require("../../../services/notificationService");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

async function requestClaim(referrerId, tierId, clientSignals = {}) {
  const milestone = referralProgressService.getMilestone(tierId);
  if (!milestone) throw new ApiError("Invalid milestone tier", 400);

  const progress = await referralProgressService.getProgress(referrerId);
  if (progress.suspended) throw new ApiError("الإحالة معلّقة — تواصل مع الدعم", 403);
  if (progress.blacklisted) throw new ApiError("الحساب غير مؤهل للمكافآت", 403);

  const status = progress.milestoneStatus[tierId];
  if (status === "claimed") throw new ApiError("تم جمع هذه المكافأة مسبقاً", 400);
  if (status !== "ready") throw new ApiError("لم تكتمل متطلبات هذه المرحلة بعد", 400);

  const existing = await ReferralRewardQueue.findOne({
    referrerId,
    tierId,
    status: { $in: ["pending", "approved", "completed"] },
  });
  if (existing) {
    if (existing.status === "completed") throw new ApiError("تم جمع هذه المكافأة مسبقاً", 400);
    if (existing.status === "pending") throw new ApiError("المكافأة قيد المراجعة", 400);
    return existing;
  }

  const fraud = await fraudRiskService.evaluateAndStore(referrerId, {
    userId: referrerId,
    action: "claim_reward",
    clientSignals,
  });

  const row = await ReferralRewardQueue.create({
    referrerId,
    tierId,
    status: "pending",
    rewardPayload: milestone.reward,
    fraudScoreAtClaim: fraud.score,
  });

  publish(Events.REFERRAL_REWARD_CLAIM_REQUESTED, {
    referrerId: String(referrerId),
    tierId,
    rewardId: String(row._id),
    fraudScore: fraud.score,
  });

  if (fraud.score <= AUTO_APPROVE_MAX_RISK && !fraud.blacklisted) {
    return approveReward(String(row._id), null, { auto: true });
  }

  row.status = "pending";
  await row.save();
  return row;
}

async function approveReward(rewardId, reviewerId = null, { auto = false } = {}) {
  const row = await ReferralRewardQueue.findById(rewardId);
  if (!row) throw new ApiError("Reward not found", 404);
  if (row.status === "completed") return row;
  if (row.status === "rejected") throw new ApiError("Reward was rejected", 400);

  const milestone = referralProgressService.getMilestone(row.tierId);
  if (!milestone) throw new ApiError("Invalid tier on reward", 400);

  const chips = milestone.reward?.chips || 0;
  if (chips > 0) {
    await withMongoTransaction(async (session) => {
      await ledgerDeposit({
        session,
        userId: row.referrerId,
        amount: chips,
        meta: { source: "referral_milestone", tierId: row.tierId },
        ledgerType: "confirmed_deposit",
      });
    });
  }

  let vipHistoryId = null;
  if (milestone.reward?.vipLevel) {
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

  row.status = "completed";
  row.autoApproved = auto;
  row.reviewedBy = reviewerId;
  row.reviewedAt = new Date();
  row.completedAt = new Date();
  row.walletTxMeta = { chips };
  row.vipHistoryId = vipHistoryId;
  await row.save();

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
  });

  return row;
}

async function rejectReward(rewardId, reviewerId, reason = "") {
  const row = await ReferralRewardQueue.findById(rewardId);
  if (!row) throw new ApiError("Reward not found", 404);
  if (row.status === "completed") throw new ApiError("Already completed", 400);
  row.status = "rejected";
  row.reviewedBy = reviewerId;
  row.reviewedAt = new Date();
  row.rejectReason = String(reason || "").slice(0, 500);
  await row.save();
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
