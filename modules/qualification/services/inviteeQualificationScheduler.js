"use strict";

const User = require("../../../models/userModel");
const logger = require("../../../utils/logger");
const qualificationEngine = require("./qualificationEngine");
const {
  REFERRAL_MILESTONES,
  requirementsForMilestone,
} = require("../../referral/config/referralMilestonesConfig");

const DEBOUNCE_MS = 1500;
const pending = new Map();

async function runReQualification(userId) {
  const user = await User.findById(userId).select("referredBy").lean();
  if (!user?.referredBy) return { skipped: true, reason: "not_invitee" };

  const results = [];
  for (const milestone of REFERRAL_MILESTONES) {
    const r = await qualificationEngine.qualifyIfMet(
      userId,
      milestone.qualificationKey,
      requirementsForMilestone(milestone)
    );
    results.push({ tierId: milestone.tierId, ...r });
  }
  return { userId: String(userId), results };
}

function scheduleInviteeReQualification(userId) {
  if (!userId) return;
  const key = String(userId);
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(key);
    runReQualification(key).catch((err) => {
      logger.warn("invitee_requalification_failed", {
        userId: key,
        reason: err?.message || String(err),
      });
    });
  }, DEBOUNCE_MS);

  pending.set(key, { timer });
}

function clearSchedulerForTests() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}

module.exports = {
  scheduleInviteeReQualification,
  runReQualification,
  clearSchedulerForTests,
};
