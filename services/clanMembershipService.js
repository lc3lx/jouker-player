const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanJoinRequest = require("../models/clanJoinRequestModel");
const User = require("../models/userModel");
const { withMongoTransaction } = require("./walletLedgerService");
const clanService = require("./clanService");
const clanPermissionService = require("./clanPermissionService");
const presenceService = require("./presenceService");
const notificationService = require("./notificationService");
const clanRealtime = require("./clanRealtime");
const chatService = require("./chatService");

// ─── system chat helper (best-effort; never blocks the mutation) ──────────────
function systemChat(clanId, actorId, body, meta = {}) {
  chatService
    .sendSystemMessage({ channel: "clan", channelId: clanId, actorId, body, meta })
    .catch(() => {});
}

// ─── notification helper ──────────────────────────────────────────────────────
function notify(userId, { title, subtitle = "", icon = "people", sourceType, sourceId, meta = {} }) {
  if (!userId) return;
  notificationService
    .createNotification({ userId, category: "clan", title, subtitle, icon, sourceType, sourceId, meta })
    .catch(() => {});
}

// ─── shared internal membership mutators (used by join / invite / request) ────
/**
 * Atomically seat a user into a clan. The findOneAndUpdate guard increments
 * memberCount only while there is room and the clan is active, so capacity can
 * never be overshot under concurrency. The unique index on ClanMember.user is the
 * one-clan-per-player guarantee (a duplicate throws → caller's txn aborts, and the
 * memberCount increment rolls back with it).
 */
async function addMemberInternal(session, clanId, userId, role = "member") {
  const clan = await Clan.findOneAndUpdate(
    {
      _id: clanId,
      status: "active",
      $expr: { $lt: ["$memberCount", "$maxMembers"] },
    },
    { $inc: { memberCount: 1 } },
    { new: true, ...(session ? { session } : {}) }
  );
  if (!clan) {
    // Distinguish "not found/inactive" from "full" for a clearer error.
    const exists = await Clan.findById(clanId).select("status").lean();
    if (!exists || exists.status !== "active") throw new ApiError("Clan not available", 404);
    throw new ApiError("Clan is full", 409);
  }
  await ClanMember.create([{ clan: clanId, user: userId, role }], session ? { session } : {});
  await clanService.setUserClanDenorm(session, userId, clan, role);
  return clan;
}

async function removeMemberInternal(session, clanId, userId) {
  const res = await ClanMember.deleteOne(
    { clan: clanId, user: userId },
    session ? { session } : {}
  );
  if (res.deletedCount) {
    await Clan.updateOne(
      { _id: clanId, memberCount: { $gt: 0 } },
      { $inc: { memberCount: -1 } },
      session ? { session } : {}
    );
  }
  await clanService.setUserClanDenorm(session, userId, null, null);
  return res.deletedCount > 0;
}

// ─── reads ────────────────────────────────────────────────────────────────────
async function getMembership(userId) {
  const member = await ClanMember.findOne({ user: userId }).lean();
  if (!member) return null;
  const clan = await Clan.findById(member.clan).lean();
  if (!clan || clan.status === "deleted") return null;
  return { clan: clanService.serializeSummary(clan), role: member.role, joinedAt: member.joinedAt };
}

async function batchMembership(userIds = []) {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return {};
  const members = await ClanMember.find({ user: { $in: ids } })
    .select("user clan role")
    .lean();
  const clanIds = [...new Set(members.map((m) => String(m.clan)))];
  const clans = await Clan.find({ _id: { $in: clanIds }, status: "active" })
    .select("name tag logo stats.rankScore")
    .lean();
  const clanMap = new Map(clans.map((c) => [String(c._id), c]));
  const out = {};
  for (const m of members) {
    const c = clanMap.get(String(m.clan));
    if (!c) continue;
    out[String(m.user)] = {
      clanId: String(c._id),
      name: c.name,
      tag: c.tag,
      logo: c.logo || null,
      role: m.role,
    };
  }
  return out;
}

async function listMembers(clanId, { withPresence = true } = {}) {
  const members = await ClanMember.find({ clan: clanId })
    .populate("user", "name profileImg")
    .sort({ createdAt: 1 })
    .lean();
  let presence = {};
  if (withPresence) {
    const ids = members.map((m) => String(m.user?._id || m.user));
    presence = await presenceService.getPresenceBatch(ids);
  }
  return members.map((m) => {
    const uid = String(m.user?._id || m.user);
    return {
      userId: uid,
      name: m.user?.name || m.displayName || null,
      avatar: m.user?.profileImg || m.avatar || null,
      role: m.role,
      joinedAt: m.joinedAt,
      contribution: m.contribution || {},
      presence: presence[uid] || null,
    };
  });
}

// ─── join / leave ─────────────────────────────────────────────────────────────
async function joinClan(userId, clanId, { message } = {}) {
  if (!mongoose.isValidObjectId(clanId)) throw new ApiError("Clan not found", 404);
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);

  const already = await ClanMember.findOne({ user: userId }).lean();
  if (already) {
    if (String(already.clan) === String(clanId)) {
      throw new ApiError("You are already in this clan", 409);
    }
    throw new ApiError("You already belong to a clan", 409);
  }

  if (clan.joinType === "invite") {
    throw new ApiError("This clan is invite-only", 403);
  }

  if (clan.joinType === "request") {
    // Queue a join request (accepted later by a permitted member — Phase D).
    try {
      const [reqDoc] = await ClanJoinRequest.create([
        { clan: clanId, user: userId, message: String(message || "").slice(0, 200) },
      ]);
      clanRealtime.emitToClan(clanId, "clan:request_new", {
        requestId: String(reqDoc._id),
        userId: String(userId),
      });
      return { status: "requested", requestId: String(reqDoc._id) };
    } catch (err) {
      if (clanService.isDuplicateKey(err)) {
        throw new ApiError("You already have a pending request for this clan", 409);
      }
      throw err;
    }
  }

  // public → instant seat
  try {
    await withMongoTransaction((session) => addMemberInternal(session, clanId, userId, "member"));
  } catch (err) {
    if (clanService.isDuplicateKey(err)) throw new ApiError("You already belong to a clan", 409);
    throw err;
  }
  clanRealtime.emitToClan(clanId, "clan:member_update", { type: "joined", userId: String(userId) });
  systemChat(clanId, userId, "انضم عضو جديد إلى العشيرة", { event: "join", userId: String(userId) });
  notify(clan.owner, {
    title: "عضو جديد في العشيرة",
    subtitle: "انضم لاعب جديد إلى عشيرتك",
    sourceType: "clan_member_join",
    sourceId: `${clanId}:${userId}`,
    meta: { clanId: String(clanId), userId: String(userId) },
  });
  return { status: "joined", clanId: String(clanId) };
}

async function leaveClan(userId) {
  const member = await ClanMember.findOne({ user: userId }).lean();
  if (!member) throw new ApiError("You are not in a clan", 404);
  if (member.role === "owner") {
    throw new ApiError("Owner must transfer ownership or disband the clan before leaving", 400);
  }
  const clanId = member.clan;
  await withMongoTransaction((session) => removeMemberInternal(session, clanId, userId));
  clanRealtime.emitToClan(clanId, "clan:member_update", { type: "left", userId: String(userId) });
  systemChat(clanId, userId, "غادر أحد الأعضاء العشيرة", { event: "leave", userId: String(userId) });
  const clan = await Clan.findById(clanId).select("owner").lean();
  if (clan) {
    notify(clan.owner, {
      title: "مغادرة عضو",
      subtitle: "غادر أحد الأعضاء عشيرتك",
      icon: "exit",
      sourceType: "clan_member_leave",
      sourceId: `${clanId}:${userId}:${Date.now()}`,
      meta: { clanId: String(clanId), userId: String(userId) },
    });
  }
  return { status: "left" };
}

// ─── moderation: kick / role changes / transfer ───────────────────────────────
async function requireActor(clanId, actorId) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  const actor = await ClanMember.findOne({ clan: clanId, user: actorId }).lean();
  if (!actor) throw new ApiError("You are not a member of this clan", 403);
  return { clan, actor };
}

async function kickMember(actorId, clanId, targetUserId) {
  if (String(actorId) === String(targetUserId)) throw new ApiError("Use leave instead", 400);
  const { clan, actor } = await requireActor(clanId, actorId);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, "kick", settings);
  const target = await ClanMember.findOne({ clan: clanId, user: targetUserId }).lean();
  if (!target) throw new ApiError("Member not found", 404);
  if (!clanPermissionService.canManageTarget(actor.role, target.role)) {
    throw new ApiError("You cannot kick this member", 403);
  }
  await withMongoTransaction((session) => removeMemberInternal(session, clanId, targetUserId));
  clanRealtime.emitToClan(clanId, "clan:member_update", {
    type: "kicked",
    userId: String(targetUserId),
    by: String(actorId),
  });
  notify(targetUserId, {
    title: "تمت إزالتك من العشيرة",
    subtitle: "قام أحد القادة بإزالتك من العشيرة",
    icon: "warning",
    sourceType: "clan_kick",
    sourceId: `${clanId}:${targetUserId}:${Date.now()}`,
    meta: { clanId: String(clanId) },
  });
  return { status: "kicked" };
}

async function setMemberRole(actorId, clanId, targetUserId, newRole) {
  const { clan, actor } = await requireActor(clanId, actorId);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, "manageRoles", settings);
  clanPermissionService.assertCanAssignRole(actor.role, newRole);
  const target = await ClanMember.findOne({ clan: clanId, user: targetUserId });
  if (!target) throw new ApiError("Member not found", 404);
  if (!clanPermissionService.canManageTarget(actor.role, target.role)) {
    throw new ApiError("You cannot manage this member", 403);
  }
  const wasHigher = clanPermissionService.rank(newRole) > clanPermissionService.rank(target.role);
  target.role = newRole;
  await target.save();
  await User.updateOne({ _id: targetUserId }, { $set: { "clan.role": newRole } });
  clanRealtime.emitToClan(clanId, "clan:role_update", {
    userId: String(targetUserId),
    role: newRole,
  });
  systemChat(clanId, actorId, wasHigher ? "تمت ترقية عضو" : "تم تغيير رتبة عضو", {
    event: "role",
    userId: String(targetUserId),
    role: newRole,
  });
  notify(targetUserId, {
    title: wasHigher ? "تمت ترقيتك" : "تم تغيير رتبتك",
    subtitle: `رتبتك الجديدة في العشيرة: ${newRole}`,
    icon: "medal",
    sourceType: "clan_role",
    sourceId: `${clanId}:${targetUserId}:${Date.now()}`,
    meta: { clanId: String(clanId), role: newRole },
  });
  return { status: "updated", role: newRole };
}

async function transferOwnership(actorId, clanId, targetUserId) {
  if (String(actorId) === String(targetUserId)) throw new ApiError("Already the owner", 400);
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  if (String(clan.owner) !== String(actorId)) throw new ApiError("Only the owner can transfer", 403);
  const target = await ClanMember.findOne({ clan: clanId, user: targetUserId });
  if (!target) throw new ApiError("Member not found", 404);

  await withMongoTransaction(async (session) => {
    /**
     * Atomically CLAIM the transfer: the update only matches while `actorId` is
     * STILL the owner. Without this, two concurrent transfers from the same owner
     * to different members both pass the read-time check above and each promote
     * their target — leaving the clan with multiple owner-role members. Losing
     * callers match nothing and are rejected.
     */
    const claimed = await Clan.findOneAndUpdate(
      { _id: clanId, owner: actorId, status: "active" },
      { $set: { owner: targetUserId } },
      { new: false, ...(session ? { session } : {}) }
    );
    if (!claimed) throw new ApiError("Only the owner can transfer", 403);

    await ClanMember.updateOne(
      { clan: clanId, user: actorId },
      { $set: { role: "leader" } },
      session ? { session } : {}
    );
    await ClanMember.updateOne(
      { clan: clanId, user: targetUserId },
      { $set: { role: "owner" } },
      session ? { session } : {}
    );
    await User.updateOne({ _id: actorId }, { $set: { "clan.role": "leader" } }, session ? { session } : {});
    await User.updateOne({ _id: targetUserId }, { $set: { "clan.role": "owner" } }, session ? { session } : {});
  });

  clanRealtime.emitToClan(clanId, "clan:role_update", { type: "transfer", newOwner: String(targetUserId) });
  systemChat(clanId, targetUserId, "تم نقل ملكية العشيرة", {
    event: "transfer",
    newOwner: String(targetUserId),
  });
  notify(targetUserId, {
    title: "أصبحت زعيم العشيرة",
    subtitle: "تم نقل ملكية العشيرة إليك",
    icon: "crown",
    sourceType: "clan_transfer",
    sourceId: `${clanId}:${targetUserId}:${Date.now()}`,
    meta: { clanId: String(clanId) },
  });
  return { status: "transferred", newOwner: String(targetUserId) };
}

// ─── disband (owner only) ─────────────────────────────────────────────────────
async function disbandClan(actorId, clanId) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status === "deleted") throw new ApiError("Clan not found", 404);
  if (String(clan.owner) !== String(actorId)) throw new ApiError("Only the owner can disband", 403);

  await withMongoTransaction(async (session) => {
    const members = await ClanMember.find({ clan: clanId }).select("user").lean();
    const ids = members.map((m) => m.user);
    await ClanMember.deleteMany({ clan: clanId }, session ? { session } : {});
    await User.updateMany(
      { _id: { $in: ids } },
      { $set: { clan: { id: null, tag: null, role: null } } },
      session ? { session } : {}
    );
    clan.status = "deleted";
    clan.deletedAt = new Date();
    clan.memberCount = 0;
    await clan.save(session ? { session } : {});
  });
  clanRealtime.emitToClan(clanId, "clan:disbanded", { clanId: String(clanId) });
  return { status: "disbanded" };
}

module.exports = {
  addMemberInternal,
  removeMemberInternal,
  getMembership,
  batchMembership,
  listMembers,
  joinClan,
  leaveClan,
  kickMember,
  setMemberRole,
  transferOwnership,
  disbandClan,
  notify,
};
