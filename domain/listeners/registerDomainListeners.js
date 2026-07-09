"use strict";

const { subscribe } = require("../events/domainEventBus");
const Events = require("../events/eventTypes");
const playerProgressService = require("../../modules/playerProgress/services/playerProgressService");
const { XP_RATES, xpFromDeposit } = require("../../modules/playerProgress/config/playerProgressConfig");
const qualificationEngine = require("../../modules/qualification/services/qualificationEngine");
const referralProgressService = require("../../modules/referral/services/referralProgressService");
const referralAnalyticsService = require("../../modules/referral/services/referralAnalyticsService");
const fraudRiskService = require("../../modules/fraud/services/fraudRiskService");
const {
  REFERRAL_MILESTONES,
  requirementsForMilestone,
} = require("../../modules/referral/config/referralMilestonesConfig");
const ReferralProgress = require("../../modules/referral/models/referralProgressModel");
const ReferralFraudProfile = require("../../modules/fraud/models/referralFraudProfileModel");

function registerDomainListeners() {
  subscribe(
    Events.PLAYER_DEPOSIT_COMPLETED,
    async ({ payload }) => {
      const { userId, amount, ledgerType } = payload || {};
      if (!userId) return;
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
      });
    },
    { name: "depositXpAndSnapshot" }
  );

  subscribe(
    Events.PLAYER_COMPLETED_GAME,
    async ({ payload }) => {
      const { userId, gameType, handsPlayed = 0 } = payload || {};
      if (!userId) return;
      const xp =
        gameType === "poker"
          ? XP_RATES.pokerHand
          : XP_RATES.cardGame;
      await playerProgressService.grantXp(userId, xp, {
        source: gameType === "poker" ? "poker_hand" : "game",
        sourceId: gameType || "card",
      });
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        gamesPlayed: 1,
        completedMatches: 1,
        handsPlayed: gameType === "poker" ? 1 : handsPlayed,
      });
    },
    { name: "gameXpSnapshot" }
  );

  subscribe(
    Events.PLAYER_COMPLETED_SPIN,
    async ({ payload }) => {
      const { userId } = payload || {};
      if (!userId) return;
      await playerProgressService.grantXp(userId, XP_RATES.spin, {
        source: "spin",
        sourceId: payload.sourceId || "",
      });
      await referralAnalyticsService.updateInviteeSnapshot(userId, { spins: 1 });
    },
    { name: "spinXpSnapshot" }
  );

  subscribe(
    Events.PLAYER_LEVEL_UP,
    async ({ payload }) => {
      const { userId, levelAfter } = payload || {};
      if (!userId) return;
      await referralAnalyticsService.updateInviteeSnapshot(userId, {
        level: levelAfter,
      });
      for (const milestone of REFERRAL_MILESTONES) {
        await qualificationEngine.qualifyIfMet(
          userId,
          milestone.qualificationKey,
          requirementsForMilestone(milestone)
        );
      }
    },
    { name: "levelUpQualification" }
  );

  subscribe(
    Events.INVITEE_QUALIFIED,
    async ({ payload }) => {
      await referralProgressService.onInviteeQualified({ payload });
      await referralAnalyticsService.refreshAverages(payload?.referredBy || payload?.snapshot?.referredBy);
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
      }
    },
    { name: "referralLinkedAnalytics" }
  );

  subscribe(
    Events.FRAUD_RISK_UPDATED,
    async ({ payload }) => {
      if (!payload?.userId) return;
      if (payload.suspended) {
        await ReferralProgress.findOneAndUpdate(
          { referrerId: payload.userId },
          { $set: { suspended: true } }
        );
      }
    },
    { name: "fraudSuspendReferral" }
  );

  subscribe(
    Events.PLAYER_REGISTERED,
    async ({ payload }) => {
      if (payload?.userId && payload?.clientSignals) {
        await ReferralFraudProfile.findOneAndUpdate(
          { userId: payload.userId },
          {
            $set: {
              signals: payload.clientSignals,
            },
          },
          { upsert: true }
        );
      }
    },
    { name: "fraudStoreClientSignals" }
  );
}

module.exports = { registerDomainListeners };
