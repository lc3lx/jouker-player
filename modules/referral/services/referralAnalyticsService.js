"use strict";

const User = require("../../../models/userModel");
const ReferralAnalytics = require("../models/referralAnalyticsModel");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");
const ReferralRewardQueue = require("../models/referralRewardQueueModel");
const { utcDayStr } = require("../../../utils/utcDay");
const { XP_PER_LEVEL } = require("../../playerProgress/config/playerProgressConfig");

const refreshDebouncers = new Map();

function scheduleRefreshAverages(referrerId) {
  if (!referrerId) return;
  const key = String(referrerId);
  if (refreshDebouncers.has(key)) clearTimeout(refreshDebouncers.get(key));
  refreshDebouncers.set(
    key,
    setTimeout(() => {
      refreshDebouncers.delete(key);
      refreshAverages(referrerId).catch(() => {});
    }, 5000)
  );
}

function clearRefreshDebouncersForTests() {
  for (const timer of refreshDebouncers.values()) clearTimeout(timer);
  refreshDebouncers.clear();
}

async function ensureAnalytics(referrerId) {
  return ReferralAnalytics.findOneAndUpdate(
    { referrerId },
    { $setOnInsert: { referrerId, registrationDate: new Date() } },
    { upsert: true, new: true }
  );
}

async function onReferralLinked({ payload }) {
  const referrerId = payload?.referrerId;
  if (!referrerId) return;
  await ReferralAnalytics.findOneAndUpdate(
    { referrerId },
    {
      $set: { lastInviteActivityAt: new Date() },
      $setOnInsert: {
        registrationDate: new Date(),
        totalInvited: 0,
        firstInviteAt: new Date(),
      },
    },
    { upsert: true }
  );
  scheduleRefreshAverages(referrerId);
}

async function refreshAverages(referrerId) {
  const snaps = await ReferralInviteeSnapshot.find({ referrerId }).lean();
  if (!snaps.length) return ensureAnalytics(referrerId);

  const total = snaps.length;
  const sumLevel = snaps.reduce((a, s) => a + (s.level || 1), 0);
  const sumRecharge = snaps.reduce((a, s) => a + (s.totalRecharge || 0), 0);
  const qualified = snaps.filter((s) => (s.qualifiedTiers || []).length > 0).length;
  const activeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const active = snaps.filter(
    (s) => s.lastActiveAt && new Date(s.lastActiveAt).getTime() >= activeCutoff
  ).length;

  const rewardsPaid = await ReferralRewardQueue.aggregate([
    { $match: { referrerId, status: "completed" } },
    { $group: { _id: null, chips: { $sum: "$rewardPayload.chips" } } },
  ]);

  const totalRewardsPaid = rewardsPaid[0]?.chips || 0;

  return ReferralAnalytics.findOneAndUpdate(
    { referrerId },
    {
      $set: {
        totalInvited: total,
        qualifiedInvitees: qualified,
        activeInvitees: active,
        averageLevel: total ? sumLevel / total : 0,
        averageRecharge: total ? sumRecharge / total : 0,
        averageLifetimeValue: total ? sumRecharge / total : 0,
        totalRewardsPaid,
        conversionRate: total ? qualified / total : 0,
        lastInviteActivityAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
}

async function getAnalytics(referrerId, { refresh = true } = {}) {
  if (refresh) await refreshAverages(referrerId);
  return ReferralAnalytics.findOne({ referrerId }).lean();
}

async function listAnalytics({ page = 1, limit = 20 } = {}) {
  const skip = (Math.max(page, 1) - 1) * Math.min(limit, 100);
  const [rows, total] = await Promise.all([
    ReferralAnalytics.find()
      .sort({ totalInvited: -1 })
      .skip(skip)
      .limit(Math.min(limit, 100))
      .lean(),
    ReferralAnalytics.countDocuments(),
  ]);
  return { rows, total, page: Math.max(page, 1) };
}

async function incrementActiveDayIfNew(referrerId, inviteeId) {
  const today = utcDayStr();
  await ReferralInviteeSnapshot.updateOne(
    { referrerId, inviteeId, lastActiveDayUtc: { $ne: today } },
    { $inc: { activeDays: 1 }, $set: { lastActiveDayUtc: today } }
  );
}

async function updateInviteeSnapshot(userId, patch = {}) {
  const user = await User.findById(userId).select("referredBy createdAt").lean();
  if (!user?.referredBy) return null;

  if (patch.trackActiveDay !== false) {
    await incrementActiveDayIfNew(user.referredBy, userId);
  }

  const inc = {};
  if (patch.handsPlayed) inc.handsPlayed = patch.handsPlayed;
  if (patch.spins) inc.spins = patch.spins;
  if (patch.gamesPlayed) inc.gamesPlayed = patch.gamesPlayed;
  if (patch.completedMatches) inc.completedMatches = patch.completedMatches;
  if (patch.recharge) inc.totalRecharge = patch.recharge;

  const set = { lastActiveAt: new Date() };
  if (patch.level != null) set.level = patch.level;
  if (patch.lifetimeXp != null) set.xp = patch.lifetimeXp;
  else if (patch.xp != null) set.xp = patch.xp;

  const update = {
    $set: set,
    $setOnInsert: {
      referrerId: user.referredBy,
      inviteeId: userId,
      registeredAt: user.createdAt || new Date(),
      qualifiedTiers: [],
    },
  };
  if (Object.keys(inc).length) update.$inc = inc;

  const snap = await ReferralInviteeSnapshot.findOneAndUpdate(
    { referrerId: user.referredBy, inviteeId: userId },
    update,
    { upsert: true, new: true }
  );

  scheduleRefreshAverages(user.referredBy);
  return snap;
}

function lifetimeXpFromProgress(level, experience) {
  const lvl = Math.max(1, Number(level) || 1);
  const xp = Math.max(0, Number(experience) || 0);
  return (lvl - 1) * XP_PER_LEVEL + xp;
}

module.exports = {
  ensureAnalytics,
  onReferralLinked,
  refreshAverages,
  scheduleRefreshAverages,
  clearRefreshDebouncersForTests,
  getAnalytics,
  listAnalytics,
  updateInviteeSnapshot,
  incrementActiveDayIfNew,
  lifetimeXpFromProgress,
};
