"use strict";

const { subscribe } = require("../events/domainEventBus");
const Events = require("../events/eventTypes");
const playerProgressService = require("../../modules/playerProgress/services/playerProgressService");
const { XP_RATES, xpFromDeposit } = require("../../modules/playerProgress/config/playerProgressConfig");
const referralProgressService = require("../../modules/referral/services/referralProgressService");
const referralAnalyticsService = require("../../modules/referral/services/referralAnalyticsService");
const fraudRiskService = require("../../modules/fraud/services/fraudRiskService");
const {
  scheduleInviteeReQualification,
} = require("../../modules/qualification/services/inviteeQualificationScheduler");
const ReferralProgress = require("../../modules/referral/models/referralProgressModel");
const ReferralFraudProfile = require("../../modules/fraud/models/referralFraudProfileModel");

function scheduleQualification(userId) {
  if (userId) scheduleInviteeReQualification(userId);
}

function registerDomainListeners() {
  subscribe(
    Events.PLAYER_DEPOSIT_COMPLETED,
    async ({ payload }) => {
      const { userId, amount, ledgerType, meta } = payload || {};
      if (!userId) return;
      if (meta?.source === "referral_milestone") return;
      const { DEPOSIT_XP_TYPES } = require("../../modules/playerProgress/config/playerProgressConfig");
      if (ledgerType && !DEPOSIT_XP_TYPES.has(ledgerType)) return;
      const xp = xpFromDeposit(amount);
      if (xp > 0) {
        await playerProgressService.grantXp(userId, xp, {
          source: "deposit",
          sourceId: payload.txId || "",
        });
      }
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        recharge: Math.max(0, Math.floor(Number(amount) || 0)),
        activity: "deposit",
      });
      scheduleQualification(userId);
    },
    { name: "depositXpAndSnapshot" }
  );

  subscribe(
    Events.PLAYER_COMPLETED_GAME,
    async ({ payload }) => {
      const { userId, gameType, handsPlayed = 0, sourceId } = payload || {};
      if (!userId) return;
      const xp =
        gameType === "poker"
          ? XP_RATES.pokerHand
          : XP_RATES.cardGame;
      await playerProgressService.grantXp(userId, xp, {
        source: gameType === "poker" ? "poker_hand" : "game",
        sourceId: sourceId || gameType || "card",
      });
      if (gameType === "poker") {
        await referralAnalyticsService.updateInviteeSnapshot(userId, {
          handsPlayed: 1,
          gamesPlayed: 1,
          activity: "game",
        });
      } else {
        await referralAnalyticsService.updateInviteeSnapshot(userId, {
          gamesPlayed: 1,
          completedMatches: 1,
          handsPlayed: handsPlayed || 1,
          activity: "game",
        });
      }
      scheduleQualification(userId);
    },
    { name: "gameXpSnapshot" }
  );

  subscribe(
    Events.PLAYER_COMPLETED_SPIN,
    async ({ payload }) => {
      const { userId, sourceId } = payload || {};
      if (!userId) return;
      await playerProgressService.grantXp(userId, XP_RATES.spin, {
        source: "spin",
        sourceId: sourceId || "",
      });
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        spins: 1,
        activity: "spin",
      });
      scheduleQualification(userId);
    },
    { name: "spinXpSnapshot" }
  );

  subscribe(
    Events.PLAYER_GAINED_XP,
    async ({ payload }) => {
      const { userId, level, experience, source } = payload || {};
      if (!userId) return;
      const lifetimeXp = referralAnalyticsService.lifetimeXpFromProgress(level, experience);
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        level,
        lifetimeXp,
        trackActiveDay: source === "task",
        activity: source === "task" ? "task" : undefined,
      });
      scheduleQualification(userId);
    },
    { name: "xpSnapshotQualification" }
  );

  subscribe(
    Events.PLAYER_LEVEL_UP,
    async ({ payload }) => {
      const { userId, levelAfter } = payload || {};
      if (!userId) return;
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        level: levelAfter,
        trackActiveDay: false,
      });
      scheduleQualification(userId);
    },
    { name: "levelUpQualification" }
  );

  subscribe(
    Events.INVITEE_QUALIFIED,
    async ({ payload }) => {
      await referralProgressService.onInviteeQualified({ payload });
      const referrerId = payload?.referredBy || payload?.snapshot?.referredBy;
      if (referrerId) {
        referralAnalyticsService.scheduleRefreshAverages(referrerId);
      }
    },
    { name: "inviteeQualifiedProgress" }
  );

  subscribe(
    Events.REFERRAL_LINKED,
    async ({ payload }) => {
      await referralAnalyticsService.onReferralLinked({ payload });
      if (payload?.inviteeId) {
        await fraudRiskService.evaluateAndStore(payload.inviteeId, {
          userId: payload.inviteeId,
          referrerId: payload.referrerId,
          action: "referral_linked",
        });
        await fraudRiskService.evaluateAndStore(payload.referrerId, {
          userId: payload.referrerId,
          referrerId: payload.referrerId,
          action: "referral_linked",
        });
      }
    },
    { name: "referralLinkedAnalytics" }
  );

  subscribe(
    Events.FRAUD_RISK_UPDATED,
    async ({ payload }) => {
      if (!payload?.userId || !payload.suspended) return;
      await ReferralProgress.findOneAndUpdate(
        {
          referrerId: payload.userId,
          suspendedReason: { $ne: "admin" },
          blacklisted: { $ne: true },
        },
        { $set: { suspended: true, suspendedReason: "fraud" } }
      );
    },
    { name: "fraudSuspendReferral" }
  );

  subscribe(
    Events.PLAYER_REGISTERED,
    async ({ payload }) => {
      if (payload?.userId && payload?.clientSignals) {
        await ReferralFraudProfile.findOneAndUpdate(
          { userId: payload.userId },
          { $set: { signals: payload.clientSignals } },
          { upsert: true }
        );
      }
    },
    { name: "fraudStoreClientSignals" }
  );

  subscribe(
    Events.PLAYER_SESSION_STARTED,
    async ({ payload }) => {
      const { userId } = payload || {};
      if (!userId) return;
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        activity: "login",
      });
      scheduleQualification(userId);
    },
    { name: "sessionActiveDay" }
  );
}

module.exports = { registerDomainListeners };
