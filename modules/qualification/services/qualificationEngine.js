"use strict";

const User = require("../../../models/userModel");
const Player = require("../../../models/playerModel");
const ReferralInviteeSnapshot = require("../../referral/models/referralInviteeSnapshotModel");
const QualificationRecord = require("../models/qualificationRecordModel");
const { normalizeRequirements } = require("../validators/requirementsValidator");
const { XP_PER_LEVEL } = require("../../playerProgress/config/playerProgressConfig");
const { publish } = require("../../../domain/events/domainEventBus");
const Events = require("../../../domain/events/eventTypes");

function accountAgeDays(createdAt, now = new Date()) {
  if (!createdAt) return 0;
  const ms = now.getTime() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

async function buildPlayerSnapshot(userId) {
  const [user, player, inviteeSnap] = await Promise.all([
    User.findById(userId).select("createdAt referredBy").lean(),
    Player.findOne({ user: userId }).lean(),
    ReferralInviteeSnapshot.findOne({ inviteeId: userId }).lean(),
  ]);

  const s = player?.stats || {};
  const snap = inviteeSnap || {};
  const level = s.level || 1;
  const inLevelXp = s.experience || 0;
  const lifetimeXp = (level - 1) * XP_PER_LEVEL + inLevelXp;

  return {
    userId: String(userId),
    level,
    xp: Math.max(lifetimeXp, snap.xp || 0),
    gamesPlayed: Math.max(s.gamesPlayed || 0, snap.gamesPlayed || 0),
    handsPlayed: snap.handsPlayed || 0,
    spins: snap.spins || 0,
    completedMatches: snap.completedMatches || 0,
    totalRecharge: snap.totalRecharge || 0,
    activeDays: snap.activeDays || 0,
    accountAgeDays: accountAgeDays(user?.createdAt),
    referredBy: user?.referredBy ? String(user.referredBy) : null,
  };
}

function evaluateSnapshot(snapshot, requirements) {
  const req = normalizeRequirements(requirements);
  const matched = {};
  const missing = {};

  const checks = [
    ["minLevel", snapshot.level],
    ["minXp", snapshot.xp],
    ["minRecharge", snapshot.totalRecharge],
    ["minHandsPlayed", snapshot.handsPlayed],
    ["minSpins", snapshot.spins],
    ["minGamesPlayed", snapshot.gamesPlayed],
    ["minCompletedMatches", snapshot.completedMatches],
    ["minActiveDays", snapshot.activeDays],
    ["accountAgeDays", snapshot.accountAgeDays],
  ];

  for (const [key, actual] of checks) {
    const needed = req[key] || 0;
    if (needed <= 0) {
      matched[key] = actual;
      continue;
    }
    if (actual >= needed) matched[key] = actual;
    else missing[key] = { required: needed, actual };
  }

  return {
    qualified: Object.keys(missing).length === 0,
    matched,
    missing,
    requirements: req,
    snapshot,
  };
}

async function evaluatePlayer(userId, requirements) {
  const snapshot = await buildPlayerSnapshot(userId);
  return evaluateSnapshot(snapshot, requirements);
}

async function recordQualification(userId, achievementKey, evaluation) {
  if (!evaluation?.qualified) return null;
  const existing = await QualificationRecord.findOne({
    userId,
    achievementKey,
  }).lean();
  if (existing) return existing;

  try {
    return await QualificationRecord.create({
      userId,
      achievementKey,
      requirements: evaluation.requirements,
      snapshot: evaluation.snapshot,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return QualificationRecord.findOne({ userId, achievementKey }).lean();
    }
    throw err;
  }
}

async function qualifyIfMet(userId, achievementKey, requirements) {
  const existing = await QualificationRecord.findOne({ userId, achievementKey }).lean();
  if (existing) {
    const snapshot = await buildPlayerSnapshot(userId);
    publish(Events.INVITEE_QUALIFIED, {
      userId: String(userId),
      achievementKey,
      snapshot,
      referredBy: snapshot.referredBy,
      reconciled: true,
    });
    return { qualified: true, evaluation: null, record: existing, alreadyRecorded: true };
  }

  const evaluation = await evaluatePlayer(userId, requirements);
  if (!evaluation.qualified) return { qualified: false, evaluation };

  try {
    const record = await QualificationRecord.create({
      userId,
      achievementKey,
      requirements: evaluation.requirements,
      snapshot: evaluation.snapshot,
    });
    publish(Events.INVITEE_QUALIFIED, {
      userId: String(userId),
      achievementKey,
      snapshot: evaluation.snapshot,
      referredBy: evaluation.snapshot.referredBy,
    });
    return { qualified: true, evaluation, record };
  } catch (err) {
    if (err?.code === 11000) {
      const record = await QualificationRecord.findOne({ userId, achievementKey }).lean();
      const snapshot = evaluation.snapshot || (await buildPlayerSnapshot(userId));
      publish(Events.INVITEE_QUALIFIED, {
        userId: String(userId),
        achievementKey,
        snapshot,
        referredBy: snapshot.referredBy,
        reconciled: true,
      });
      return { qualified: true, evaluation, record, alreadyRecorded: true };
    }
    throw err;
  }
}

module.exports = {
  buildPlayerSnapshot,
  evaluatePlayer,
  evaluateSnapshot,
  recordQualification,
  qualifyIfMet,
};
