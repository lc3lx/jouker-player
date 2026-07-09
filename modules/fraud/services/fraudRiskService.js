"use strict";

const User = require("../../../models/userModel");
const ReferralInviteeSnapshot = require("../../referral/models/referralInviteeSnapshotModel");
const ReferralFraudProfile = require("../models/referralFraudProfileModel");
const {
  SIGNAL_WEIGHTS,
  riskBand,
  SUSPEND_MIN_RISK,
} = require("../config/fraudSignalsConfig");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.floor(Number(n) || 0)));
}

async function computeRiskScore(context = {}) {
  const { userId, referrerId, clientSignals = {}, action = "general" } = context;
  const reasons = [];
  const signals = { ...clientSignals };
  let score = 0;

  if (clientSignals.emulator || clientSignals.rooted) {
    score += SIGNAL_WEIGHTS.emulator_or_rooted;
    reasons.push("جهاز محاكي أو معدّل");
  }
  if (clientSignals.vpn || clientSignals.proxy) {
    score += SIGNAL_WEIGHTS.vpn_or_proxy_hint;
    reasons.push("شبكة VPN/بروكسي محتملة");
  }
  if (clientSignals.deviceFingerprint) {
    const dupes = await User.countDocuments({
      _id: { $ne: userId },
      "referralMeta.deviceFingerprint": clientSignals.deviceFingerprint,
    });
    if (dupes > 0) {
      score += SIGNAL_WEIGHTS.repeated_registrations_same_fingerprint;
      reasons.push("بصمة جهاز مكررة");
      signals.duplicateFingerprintCount = dupes;
    }
  }

  if (referrerId && userId) {
    const sameReferrerCount = await User.countDocuments({ referredBy: referrerId });
    if (sameReferrerCount > 50) {
      score += SIGNAL_WEIGHTS.multiple_accounts_same_referrer;
      reasons.push("عدد كبير من الدعوات لنفس المُحيل");
    }
  }

  if (userId && action === "claim_reward") {
    const user = await User.findById(userId).select("createdAt").lean();
    if (user?.createdAt) {
      const ageH = (Date.now() - new Date(user.createdAt).getTime()) / 3600000;
      if (ageH < 24) {
        score += SIGNAL_WEIGHTS.fast_reward_claim_after_signup;
        reasons.push("مطالبة مكافأة سريعة بعد التسجيل");
      }
    }
    const snap = await ReferralInviteeSnapshot.findOne({ inviteeId: userId }).lean();
    if (snap?.registeredAt) {
      const lvlAgeH =
        (Date.now() - new Date(snap.registeredAt).getTime()) / 3600000;
      if ((snap.level || 1) >= 10 && lvlAgeH < 48) {
        score += SIGNAL_WEIGHTS.very_fast_level_progression;
        reasons.push("تقدم مستوى سريع جداً");
      }
    }
  }

  score = clampScore(score);
  const band = riskBand(score);

  return { score, band, reasons, signals };
}

async function upsertProfile(userId, evaluation, { suspendOnHigh = true } = {}) {
  const profile = await ReferralFraudProfile.findOneAndUpdate(
    { userId },
    {
      $set: {
        score: evaluation.score,
        band: evaluation.band,
        reasons: evaluation.reasons,
        signals: evaluation.signals,
        suspended:
          evaluation.score >= SUSPEND_MIN_RISK && !evaluation.whitelisted,
      },
      $push: {
        history: {
          $each: [
            {
              score: evaluation.score,
              reasons: evaluation.reasons,
              at: new Date(),
            },
          ],
          $slice: -50,
        },
      },
    },
    { upsert: true, new: true }
  );

  publish(Events.FRAUD_RISK_UPDATED, {
    userId: String(userId),
    score: evaluation.score,
    band: evaluation.band,
    reasons: evaluation.reasons,
    suspended: profile.suspended,
  });

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
  await upsertProfile(userId, evaluation);
  return evaluation;
}

module.exports = {
  computeRiskScore,
  evaluateAndStore,
  upsertProfile,
};
