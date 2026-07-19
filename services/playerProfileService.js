"use strict";

/**
 * Public player profile aggregation — powers the reusable in-app profile popup.
 *
 * Returns ONLY public info (never email/password/private flags to non-admins).
 * The expensive part (lifetime stats + wallet coin aggregation) is cached per
 * target for a short TTL so opening the popup repeatedly is cheap; the cheap,
 * viewer-relative parts (friendship, admin flag, hidden-profile stripping) are
 * always computed fresh.
 *
 * Reuses existing infra — presenceService, vipLevelRegistry, cosmeticsService,
 * friendService, AgentProfile — rather than duplicating any of it.
 */

const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const User = require("../models/userModel");
const Player = require("../models/playerModel");
const WalletTransaction = require("../models/walletTransactionModel");
const AgentProfile = require("../models/agentProfileModel");
const VIPSubscription = require("../models/vipSubscriptionModel");
const presenceService = require("./presenceService");
const vipService = require("./vipService");
const vipLevelRegistry = require("./vipLevelRegistry");
const cosmeticsService = require("./cosmeticsService");
const friendService = require("./friendService");

const WIN_TYPES = ["win", "game_win", "island_jackpot_win"];
const LOSS_TYPES = ["game_loss", "bet"];

const GAME_LABELS = { poker: "بوكر تكساس", trix: "تركس", tarneeb41: "طرنيب 41" };

// Short-TTL snapshot cache (target-only, viewer-independent).
const SNAPSHOT_TTL_MS = Math.max(5_000, parseInt(process.env.PROFILE_SNAPSHOT_TTL_MS || "30000", 10));
const _snap = new Map(); // targetId -> { at, data }

function shortId(id) {
  return String(id).slice(-6).toUpperCase();
}

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; }
}

/** Lifetime coin aggregation from the wallet ledger (single indexed scan). */
async function _coinStats(userId) {
  const oid = toObjectId(userId);
  if (!oid) return { totalWon: 0, totalLost: 0, biggestWin: 0, highestBalance: 0 };
  const rows = await WalletTransaction.aggregate([
    { $match: { userId: oid } },
    {
      $facet: {
        won: [
          { $match: { type: { $in: WIN_TYPES } } },
          { $group: { _id: null, total: { $sum: "$amount" }, max: { $max: "$amount" } } },
        ],
        lost: [
          { $match: { type: { $in: LOSS_TYPES } } },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ],
        peak: [{ $group: { _id: null, max: { $max: "$balanceAfter" } } }],
      },
    },
  ]);
  const f = rows[0] || {};
  return {
    totalWon: f.won?.[0]?.total || 0,
    biggestWin: f.won?.[0]?.max || 0,
    totalLost: f.lost?.[0]?.total || 0,
    highestBalance: f.peak?.[0]?.max || 0,
  };
}

/** Trim a full cosmetic display to the render-relevant fields for the popup. */
function _cosmeticView(c) {
  if (!c) return null;
  return {
    id: c.id,
    assetKey: c.assetKey,
    name: c.name,
    category: c.category || c.type,
    slot: c.slot,
    rarity: c.rarity,
    renderType: c.renderType || "png",
    previewImageUrl: c.previewImageUrl || null,
    animationUrl: c.animationUrl || null,
  };
}

/** Build the cacheable, viewer-independent snapshot for one target user. */
async function _buildSnapshot(targetId) {
  const [user, player, coin, presence, vipLevel, vipSub, cos, agent] = await Promise.all([
    User.findById(targetId)
      .select(
        "name country profileImg createdAt role active muted preferences.hideProfile " +
          "pokerHandsPlayed pokerHandsWon pokerWinStreak vip"
      )
      .lean(),
    Player.findOne({ user: targetId })
      .populate("achievements", "code title icon points category")
      .lean(),
    _coinStats(targetId),
    presenceService.getPresence(targetId),
    vipService.getVipLevel(targetId),
    VIPSubscription.findOne({ userId: targetId }).lean(),
    cosmeticsService.getProfileCosmetics(targetId),
    AgentProfile.findOne({ user: targetId, status: "approved" }).lean(),
  ]);
  if (!user) return null;

  const now = Date.now();
  const s = player?.stats || {};
  const gamesPlayed = s.gamesPlayed || 0;
  const wins = s.wins || 0;
  const vipCfg = vipLevel ? vipLevelRegistry.config(vipLevel) : null;

  // VIP expiry + days remaining + benefits preview.
  const vipExpire = vipLevel && vipSub?.expireDate && new Date(vipSub.expireDate).getTime() > now
    ? vipSub.expireDate : null;
  const daysRemaining = vipExpire ? Math.max(0, Math.ceil((new Date(vipExpire).getTime() - now) / 86400000)) : 0;

  // Cosmetics: equipped inspect + owned inventory grouped by category.
  const equippedDetailed = {};
  for (const [slot, c] of Object.entries(cos.equippedDetailed || {})) {
    equippedDetailed[slot] = _cosmeticView(c);
  }
  const inventory = {};
  for (const [cat, list] of Object.entries(cos.ownedByCategory || {})) {
    inventory[cat] = list.map(_cosmeticView);
  }
  const avatarFrame = equippedDetailed.avatar_frame?.assetKey || null;

  const achievements = ((player?.achievements) || []).map((a) => ({
    code: a.code,
    title: a.title,
    icon: a.icon || "star",
    points: a.points || 0,
    category: a.category || "general",
  }));

  const perGame = [
    {
      key: "poker",
      label: GAME_LABELS.poker,
      stats: {
        handsPlayed: user.pokerHandsPlayed || 0,
        handsWon: user.pokerHandsWon || 0,
        winStreak: user.pokerWinStreak || 0,
      },
    },
  ];

  return {
    identity: {
      id: String(user._id),
      shortId: shortId(user._id),
      name: user.name,
      country: user.country || null,
      profileImg: user.profileImg || null,
      memberSince: user.createdAt,
      hideProfile: !!user.preferences?.hideProfile,
    },
    presence: presence
      ? { status: presence.status, gameType: presence.gameType, lastSeen: presence.lastSeen, online: presence.status !== "offline" }
      : { status: "offline", gameType: null, lastSeen: null, online: false },
    vip: {
      isVip: !!vipLevel,
      level: vipLevel || null,
      name: vipCfg?.name || (vipLevel ? vipLevel : null),
      color: vipCfg?.color || null,
      badge: vipCfg?.badge || null,
      rank: vipCfg?.rank || 0,
      expireDate: vipExpire,
      daysRemaining,
      benefits: vipCfg
        ? { dailyChips: vipCfg.dailyChips, cashbackPercent: vipCfg.cashbackPercent, quiz: !!vipCfg.quiz, priorityQueue: !!vipCfg.priorityQueue }
        : null,
    },
    agent: agent
      ? {
          isAgent: true,
          displayName: agent.deposit?.displayName || user.name,
          level: agent.deposit?.level || 0,
          rating: agent.deposit?.rating ?? null,
          totalOperations: agent.deposit?.stats?.totalDeposits || 0,
          avgResponseMinutes: agent.deposit?.avgResponseMinutes || 0,
          paymentMethods: agent.deposit?.paymentMethods || [],
          workingHours: agent.deposit?.workingHours || null,
          countries: agent.deposit?.countries || [],
          whatsapp: agent.deposit?.whatsapp || null,
          telegram: agent.deposit?.telegram || null,
          depositEnabled: !!agent.deposit?.enabled,
        }
      : { isAgent: false },
    cosmetics: {
      avatarFrame,
      equipped: equippedDetailed,
      inventory,
      inventoryCount: cos.ownedCount || 0,
    },
    achievements,
    stats: {
      general: {
        gamesPlayed,
        wins,
        losses: Math.max(0, gamesPlayed - wins),
        winRate: gamesPlayed > 0 ? wins / gamesPlayed : 0,
        totalHands: user.pokerHandsPlayed || 0,
        totalPlayTimeSec: s.totalPlayTimeSec || 0,
        bestScore: s.bestScore || 0,
        level: s.level || 1,
        experience: s.experience || 0,
        totalWon: coin.totalWon,
        totalLost: coin.totalLost,
        biggestWin: coin.biggestWin,
        highestBalance: coin.highestBalance,
      },
    },
    perGame,
    moderation: { active: user.active !== false, muted: !!user.muted },
  };
}

async function _getCachedSnapshot(targetId, fresh = false) {
  const key = String(targetId);
  if (!fresh) {
    const hit = _snap.get(key);
    if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.data;
  }
  const data = await _buildSnapshot(targetId);
  if (data) {
    _snap.set(key, { at: Date.now(), data });
    if (_snap.size > 5000) _snap.delete(_snap.keys().next().value);
  }
  return data;
}

function invalidate(targetId) {
  _snap.delete(String(targetId));
}

/**
 * Public profile for `targetId` as seen by `viewerId`.
 * Adds viewer-relative relationship + admin flag; strips stats when the target
 * hides their profile (unless viewer is self or an admin).
 */
async function getPublicProfile(viewerId, targetId, { fresh = false } = {}) {
  if (!toObjectId(targetId)) throw new ApiError("Invalid user id", 400);
  const snap = await _getCachedSnapshot(targetId, fresh);
  if (!snap) throw new ApiError("User not found", 404);

  const [relationship, viewer] = await Promise.all([
    friendService.getRelationship(viewerId, targetId),
    User.findById(viewerId).select("role").lean(),
  ]);
  const viewerIsAdmin = ["admin", "manager"].includes(viewer?.role);
  const isSelf = String(viewerId) === String(targetId);

  // Deep-clone the parts we mutate so cached snapshot stays intact.
  const data = {
    ...snap,
    stats: snap.stats,
    perGame: snap.perGame,
    relationship,
    viewerIsAdmin,
    isSelf,
  };

  if (snap.identity.hideProfile && !isSelf && !viewerIsAdmin) {
    data.hidden = true;
    data.stats = null;
    data.perGame = [];
    data.achievements = [];
    data.cosmetics = { ...snap.cosmetics, inventory: {}, inventoryCount: 0 };
  }
  // Never leak the raw moderation flags to non-admins.
  if (!viewerIsAdmin) delete data.moderation;

  return data;
}

module.exports = { getPublicProfile, invalidate, _buildSnapshot };
