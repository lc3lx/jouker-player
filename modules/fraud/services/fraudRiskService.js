"use strict";

const User = require("../../../models/userModel");
const ReferralInviteeSnapshot = require("../../referral/models/referralInviteeSnapshotModel");
const ReferralFraudProfile = require("../models/referralFraudProfileModel");
const WalletTransaction = require("../../../models/walletTransactionModel");
const {
  SIGNAL_WEIGHTS,
  riskBand,
  SUSPEND_MIN_RISK,
} = require("../config/fraudSignalsConfig");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");
const referralAuditService = require("../../referral/services/referralAuditService");

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.floor(Number(n) || 0)));
}

async function loadStoredSignals(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select("referralMeta createdAt referredBy").lean(),
    ReferralFraudProfile.findOne({ userId }).select("signals").lean(),
  ]);
  return {
    ...(profile?.signals || {}),
    ...(user?.referralMeta?.deviceFingerprint
      ? { deviceFingerprint: user.referralMeta.deviceFingerprint }
      : {}),
    ...(user?.referralMeta?.appInstanceId
      ? { appInstanceId: user.referralMeta.appInstanceId }
      : {}),
    ...(user?.referralMeta?.registrationIp
      ? { registrationIp: user.referralMeta.registrationIp }
      : {}),
  };
}

async function computeRiskScore(context = {}) {
  const { userId, referrerId, clientSignals = {}, action = "general" } = context;
  const stored = userId ? await loadStoredSignals(userId) : {};
  const mergedSignals = { ...stored, ...clientSignals };
  const reasons = [];
  const signals = { ...mergedSignals };
  let score = 0;

  if (mergedSignals.emulator || mergedSignals.rooted) {
    score += SIGNAL_WEIGHTS.emulator_or_rooted;
    reasons.push("جهاز محاكي أو معدّل");
  }
  if (mergedSignals.vpn || mergedSignals.proxy) {
    score += SIGNAL_WEIGHTS.vpn_or_proxy_hint;
    reasons.push("شبكة VPN/بروكسي محتملة");
  }

  if (mergedSignals.deviceFingerprint) {
    const dupes = await User.countDocuments({
      _id: { $ne: userId },
      "referralMeta.deviceFingerprint": mergedSignals.deviceFingerprint,
    });
    if (dupes > 0) {
      score += SIGNAL_WEIGHTS.repeated_registrations_same_fingerprint;
      reasons.push("بصمة جهاز مكررة");
      signals.duplicateFingerprintCount = dupes;
    }
  }

  if (mergedSignals.appInstanceId) {
    const dupes = await User.countDocuments({
      _id: { $ne: userId },
      "referralMeta.appInstanceId": mergedSignals.appInstanceId,
    });
    if (dupes > 0) {
      score += Math.min(15, SIGNAL_WEIGHTS.repeated_registrations_same_fingerprint);
      reasons.push("معرّف تطبيق مكرر");
      signals.duplicateAppInstanceCount = dupes;
    }
  }

  if (referrerId && userId && mergedSignals.deviceFingerprint) {
    const siblingInvitees = await ReferralInviteeSnapshot.find({ referrerId })
      .select("inviteeId")
      .lean();
    const inviteeIds = siblingInvitees
      .map((s) => s.inviteeId)
      .filter((id) => String(id) !== String(userId));
    if (inviteeIds.length) {
      const similar = await User.countDocuments({
        _id: { $in: inviteeIds },
        "referralMeta.deviceFingerprint": mergedSignals.deviceFingerprint,
      });
      if (similar > 0) {
        score += SIGNAL_WEIGHTS.same_referrer_similar_devices;
        reasons.push("أجهزة متشابهة لدى مدعوين لنفس المُحيل");
        signals.similarDeviceInvitees = similar;
      }
    }
  }

  if (referrerId) {
    const sameReferrerCount = await User.countDocuments({ referredBy: referrerId });
    if (sameReferrerCount > 50) {
      score += SIGNAL_WEIGHTS.multiple_accounts_same_referrer;
      reasons.push("عدد كبير من الدعوات لنفس المُحيل");
      signals.inviteCount = sameReferrerCount;
    }
    if (sameReferrerCount > 15 && action === "claim_reward") {
      score += SIGNAL_WEIGHTS.repeated_invites_same_network;
      reasons.push("نمط دعوات متكرر");
    }
  }

  if (userId && mergedSignals.registrationIp) {
    const sameIp = await User.countDocuments({
      _id: { $ne: userId },
      "referralMeta.registrationIp": mergedSignals.registrationIp,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 3600000) },
    });
    if (sameIp >= 3) {
      score += SIGNAL_WEIGHTS.repeated_invites_same_network;
      reasons.push("تسجيلات متعددة من نفس الشبكة");
      signals.sameIpRegistrations = sameIp;
    }
  }

  if (userId && action === "claim_reward") {
    const user = await User.findById(userId).select("createdAt referredBy").lean();
    if (user?.createdAt) {
      const ageH = (Date.now() - new Date(user.createdAt).getTime()) / 3600000;
      if (ageH < 24) {
        score += SIGNAL_WEIGHTS.fast_reward_claim_after_signup;
        reasons.push("مطالبة مكافأة سريعة بعد التسجيل");
      }
    }

    const inviteeSnaps = await ReferralInviteeSnapshot.find({ referrerId: userId }).lean();
    const fastLevelers = inviteeSnaps.filter((s) => {
      if (!s.registeredAt) return false;
      const ageH = (Date.now() - new Date(s.registeredAt).getTime()) / 3600000;
      return (s.level || 1) >= 10 && ageH < 48;
    });
    if (fastLevelers.length >= 3) {
      score += SIGNAL_WEIGHTS.very_fast_level_progression;
      reasons.push("تقدم مستوى سريع لعدة مدعوين");
      signals.fastLevelInvitees = fastLevelers.length;
    }

    const recentDeposits = await WalletTransaction.countDocuments({
      userId,
      type: { $in: ["confirmed_deposit", "recharge", "agent_deposit_in"] },
      createdAt: { $gte: new Date(Date.now() - 24 * 3600000) },
    });
    if (recentDeposits >= 5) {
      score += 8;
      reasons.push("نشاط شحن مكثف");
      signals.recentDepositCount = recentDeposits;
    }
  }

  if (userId && action === "referral_linked" && referrerId) {
    const recent = await User.countDocuments({
      referredBy: referrerId,
      createdAt: { $gte: new Date(Date.now() - 24 * 3600000) },
    });
    if (recent > 10) {
      score += SIGNAL_WEIGHTS.repeated_invites_same_network;
      reasons.push("تسجيلات متكررة خلال 24 ساعة");
      signals.recentInviteCount = recent;
    }
  }

  score = clampScore(score);
  const band = riskBand(score);

  return { score, band, reasons, signals };
}

async function upsertProfile(userId, evaluation, { suspendOnHigh = true, action = "evaluate" } = {}) {
  const existing = await ReferralFraudProfile.findOne({ userId }).lean();
  const wasAdminSuspended = existing?.suspendedReason === "admin";
  const wasBlacklisted = existing?.blacklisted === true;

  const suspended =
    !wasBlacklisted &&
    !existing?.whitelisted &&
    suspendOnHigh &&
    evaluation.score >= SUSPEND_MIN_RISK &&
    !wasAdminSuspended;

  const profile = await ReferralFraudProfile.findOneAndUpdate(
    { userId },
    {
      $set: {
        score: evaluation.score,
        band: evaluation.band,
        reasons: evaluation.reasons,
        signals: evaluation.signals,
        suspended: wasBlacklisted || wasAdminSuspended || suspended,
        ...(suspended && !wasAdminSuspended ? { suspendedReason: "fraud" } : {}),
      },
      $push: {
        history: {
          $each: [
            {
              score: evaluation.score,
              reasons: evaluation.reasons,
              action,
              at: new Date(),
            },
          ],
          $slice: -100,
        },
      },
    },
    { upsert: true, new: true }
  );

  if (profile.suspended && evaluation.score >= SUSPEND_MIN_RISK) {
    publish(Events.FRAUD_RISK_UPDATED, {
      userId: String(userId),
      score: evaluation.score,
      band: evaluation.band,
      reasons: evaluation.reasons,
      suspended: true,
    });
    void referralAuditService.append({
      action: "fraud_detected",
      referrerId: userId,
      meta: { score: evaluation.score, reasons: evaluation.reasons },
    });
  }

  return profile;
}

async function evaluateAndStore(userId, context = {}) {
  const profile = await ReferralFraudProfile.findOne({ userId }).lean();
  if (profile?.whitelisted) {
    return { score: 0, band: "safe", reasons: [], signals: {}, whitelisted: true };
  }
  if (profile?.blacklisted) {
    return {
      score: 100,
      band: "manual_review",
      reasons: ["قائمة سوداء"],
      signals: {},
      blacklisted: true,
    };
  }

  const evaluation = await computeRiskScore({ ...context, userId });
  evaluation.action = context.action || "general";
  await upsertProfile(userId, evaluation, { action: evaluation.action });
  return evaluation;
}

module.exports = {
  computeRiskScore,
  evaluateAndStore,
  upsertProfile,
  loadStoredSignals,
};
