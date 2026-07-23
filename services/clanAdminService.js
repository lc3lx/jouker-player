"use strict";

const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanTournament = require("../models/clanTournamentModel");
const ClanSettings = require("../models/clanSettingsModel");
const ChatMessage = require("../models/chatMessageModel");
const User = require("../models/userModel");
const { withMongoTransaction } = require("./walletLedgerService");
const clanService = require("./clanService");
const clanMembershipService = require("./clanMembershipService");
const clanTreasuryService = require("./clanTreasuryService");
const auditService = require("./auditService");
const { ROLES } = require("../config/clanConfig");

function actorOf(req) {
  return { actor: req.user?._id || null, ip: req.ip, userAgent: req.get?.("user-agent") };
}
function audit(req, event, meta) {
  const a = actorOf(req);
  auditService
    .logEvent({ event, actor: a.actor, meta, ip: a.ip, userAgent: a.userAgent })
    .catch(() => {});
}

// ─── list / read ──────────────────────────────────────────────────────────────
exports.adminListClans = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "30", 10)));
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) {
    const safe = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ name: { $regex: safe, $options: "i" } }, { tag: { $regex: safe, $options: "i" } }];
  }
  const [rows, total] = await Promise.all([
    Clan.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Clan.countDocuments(filter),
  ]);
  res.json({ results: rows.length, total, page, limit, data: rows.map(clanService.serializeSummary) });
});

exports.adminGetClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id).lean();
  if (!clan) throw new ApiError("Clan not found", 404);
  const members = await ClanMember.find({ clan: clan._id }).populate("user", "name email").lean();
  res.json({
    data: {
      ...clanService.serializeProfile(clan),
      status: clan.status,
      bannedReason: clan.bannedReason || null,
      members: members.map((m) => ({
        userId: String(m.user?._id || m.user),
        name: m.user?.name || null,
        email: m.user?.email || null,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    },
  });
});

exports.adminStats = asyncHandler(async (req, res) => {
  const [byStatus, totalMembers, tournaments, treasuryAgg] = await Promise.all([
    Clan.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ClanMember.countDocuments({}),
    ClanTournament.countDocuments({}),
    Clan.aggregate([{ $group: { _id: null, total: { $sum: "$treasury.balance" } } }]),
  ]);
  const statusMap = {};
  for (const s of byStatus) statusMap[s._id] = s.count;
  res.json({
    data: {
      clans: statusMap,
      totalMembers,
      totalTournaments: tournaments,
      totalTreasury: treasuryAgg[0]?.total || 0,
    },
  });
});

// ─── create / edit / rename ───────────────────────────────────────────────────
exports.adminCreateClan = asyncHandler(async (req, res) => {
  const { name, tag, ownerUserId } = req.body || {};
  if (!ownerUserId || !mongoose.isValidObjectId(ownerUserId)) throw new ApiError("ownerUserId required", 400);
  const owner = await User.findById(ownerUserId).select("_id").lean();
  if (!owner) throw new ApiError("Owner user not found", 404);
  const already = await ClanMember.findOne({ user: ownerUserId }).lean();
  if (already) throw new ApiError("Owner already belongs to a clan", 409);

  const settings = await clanService.getSettings();
  const cleanTag = String(tag || "").toUpperCase().trim();
  const clan = await withMongoTransaction(async (session) => {
    const [created] = await Clan.create(
      [{ name: String(name || "").trim(), tag: cleanTag, owner: ownerUserId, memberCount: 1, maxMembers: settings.maxMembersDefault }],
      session ? { session } : {}
    );
    await ClanMember.create([{ clan: created._id, user: ownerUserId, role: "owner" }], session ? { session } : {});
    await clanService.setUserClanDenorm(session, ownerUserId, created, "owner");
    return created;
  });
  audit(req, "admin_clan_create", { clanId: String(clan._id), tag: cleanTag, ownerUserId: String(ownerUserId) });
  res.status(201).json({ data: clanService.serializeProfile(clan) });
});

exports.adminEditClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan) throw new ApiError("Clan not found", 404);
  const patch = req.body || {};
  const fields = ["name", "description", "logo", "banner", "country", "language", "joinType", "maxMembers", "rolePermissions"];
  for (const f of fields) {
    if (typeof patch[f] === "undefined") continue;
    if (f === "maxMembers") clan.maxMembers = Math.max(1, parseInt(patch.maxMembers, 10) || clan.maxMembers);
    else clan[f] = patch[f];
  }
  await clan.save();
  audit(req, "admin_clan_edit", { clanId: String(clan._id), fields: Object.keys(patch) });
  res.json({ data: clanService.serializeProfile(clan) });
});

exports.adminRenameClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan) throw new ApiError("Clan not found", 404);
  const { name, tag } = req.body || {};
  if (name) clan.name = String(name).trim();
  if (tag) {
    const t = String(tag).toUpperCase().trim();
    const taken = await Clan.findOne({ tag: t, _id: { $ne: clan._id }, status: { $ne: "deleted" } }).lean();
    if (taken) throw new ApiError("Tag already taken", 409);
    // Refresh the denormalized tag on all members.
    clan.tag = t;
    await User.updateMany({ "clan.id": clan._id }, { $set: { "clan.tag": t } });
  }
  await clan.save();
  audit(req, "admin_clan_rename", { clanId: String(clan._id), name, tag });
  res.json({ data: clanService.serializeProfile(clan) });
});

// ─── ban / restore / delete ───────────────────────────────────────────────────
exports.adminBanClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan) throw new ApiError("Clan not found", 404);
  clan.status = "banned";
  clan.bannedReason = String(req.body?.reason || "").slice(0, 500);
  clan.bannedAt = new Date();
  await clan.save();
  audit(req, "admin_clan_ban", { clanId: String(clan._id), reason: clan.bannedReason });
  res.json({ data: { status: "banned" } });
});

exports.adminRestoreClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan) throw new ApiError("Clan not found", 404);
  if (clan.status === "deleted") throw new ApiError("Cannot restore a deleted clan", 400);
  clan.status = "active";
  clan.bannedReason = null;
  clan.bannedAt = null;
  await clan.save();
  audit(req, "admin_clan_restore", { clanId: String(clan._id) });
  res.json({ data: { status: "active" } });
});

exports.adminDeleteClan = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan || clan.status === "deleted") throw new ApiError("Clan not found", 404);
  await withMongoTransaction(async (session) => {
    const members = await ClanMember.find({ clan: clan._id }).select("user").lean();
    const ids = members.map((m) => m.user);
    await ClanMember.deleteMany({ clan: clan._id }, session ? { session } : {});
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
  audit(req, "admin_clan_delete", { clanId: String(clan._id) });
  res.json({ data: { status: "deleted" } });
});

// ─── members / roles / ownership ──────────────────────────────────────────────
exports.adminTransferOwnership = asyncHandler(async (req, res) => {
  const clanId = req.params.id;
  const { userId } = req.body || {};
  const clan = await Clan.findById(clanId);
  if (!clan) throw new ApiError("Clan not found", 404);
  const target = await ClanMember.findOne({ clan: clanId, user: userId });
  if (!target) throw new ApiError("Target is not a member", 404);
  await withMongoTransaction(async (session) => {
    await ClanMember.updateOne({ clan: clanId, user: clan.owner }, { $set: { role: "leader" } }, session ? { session } : {});
    await ClanMember.updateOne({ clan: clanId, user: userId }, { $set: { role: "owner" } }, session ? { session } : {});
    await User.updateOne({ _id: clan.owner }, { $set: { "clan.role": "leader" } }, session ? { session } : {});
    await User.updateOne({ _id: userId }, { $set: { "clan.role": "owner" } }, session ? { session } : {});
    await Clan.updateOne({ _id: clanId }, { $set: { owner: userId } }, session ? { session } : {});
  });
  audit(req, "admin_clan_transfer", { clanId: String(clanId), newOwner: String(userId) });
  res.json({ data: { status: "transferred" } });
});

exports.adminSetMemberRole = asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!ROLES.includes(role) || role === "owner") throw new ApiError("Invalid role", 400);
  const member = await ClanMember.findOne({ clan: req.params.id, user: req.params.userId });
  if (!member) throw new ApiError("Member not found", 404);
  member.role = role;
  await member.save();
  await User.updateOne({ _id: req.params.userId }, { $set: { "clan.role": role } });
  audit(req, "admin_clan_set_role", { clanId: req.params.id, userId: req.params.userId, role });
  res.json({ data: { status: "updated", role } });
});

exports.adminKickMember = asyncHandler(async (req, res) => {
  const clan = await Clan.findById(req.params.id);
  if (!clan) throw new ApiError("Clan not found", 404);
  if (String(clan.owner) === String(req.params.userId)) throw new ApiError("Transfer ownership before removing the owner", 400);
  await withMongoTransaction((session) =>
    clanMembershipService.removeMemberInternal(session, req.params.id, req.params.userId)
  );
  audit(req, "admin_clan_kick", { clanId: req.params.id, userId: req.params.userId });
  res.json({ data: { status: "kicked" } });
});

// ─── config ───────────────────────────────────────────────────────────────────
exports.adminGetConfig = asyncHandler(async (req, res) => {
  const s = await ClanSettings.getDefaults();
  res.json({ data: s });
});

exports.adminUpdateConfig = asyncHandler(async (req, res) => {
  const patch = req.body || {};
  const allowed = [
    "creationCost",
    "maxMembersDefault",
    "tagMinLen",
    "tagMaxLen",
    "maxTournamentsPerClan",
    "treasuryEnabled",
    "donationDailyLimit",
    "minDonation",
    "defaultRolePermissions",
  ];
  const s = await ClanSettings.getDefaults();
  for (const k of allowed) if (typeof patch[k] !== "undefined") s[k] = patch[k];
  await s.save();
  clanService.invalidateSettingsCache();
  audit(req, "admin_clan_config_update", { fields: Object.keys(patch).filter((k) => allowed.includes(k)) });
  res.json({ data: s });
});

// ─── treasury adjust ──────────────────────────────────────────────────────────
exports.adminAdjustTreasury = asyncHandler(async (req, res) => {
  const { amount, direction } = req.body || {};
  const balance = await clanTreasuryService.adminAdjust(req.params.id, amount, direction === "out" ? "out" : "in", {
    admin: true,
  });
  audit(req, "admin_clan_treasury_adjust", { clanId: req.params.id, amount, direction });
  res.json({ data: { balance } });
});

// ─── chat moderation ──────────────────────────────────────────────────────────
exports.adminListClanChat = asyncHandler(async (req, res) => {
  const rows = await ChatMessage.find({ channel: "clan", channelId: String(req.params.id) })
    .sort({ createdAt: -1 })
    .limit(Math.min(200, parseInt(req.query.limit || "100", 10)))
    .populate("sender", "name")
    .lean();
  res.json({
    results: rows.length,
    data: rows.map((m) => ({
      id: String(m._id),
      senderId: m.sender ? String(m.sender._id || m.sender) : null,
      senderName: m.sender?.name || null,
      body: m.body,
      deleted: !!m.deleted,
      reported: !!m.reported,
      createdAt: m.createdAt,
    })),
  });
});

exports.adminModerateMessage = asyncHandler(async (req, res) => {
  const msg = await ChatMessage.findById(req.params.messageId);
  if (!msg || msg.channel !== "clan") throw new ApiError("Message not found", 404);
  if (typeof req.body?.deleted !== "undefined") msg.deleted = !!req.body.deleted;
  if (typeof req.body?.reported !== "undefined") msg.reported = !!req.body.reported;
  await msg.save();
  audit(req, "admin_clan_chat_moderate", { messageId: String(msg._id), deleted: msg.deleted });
  res.json({ data: { id: String(msg._id), deleted: msg.deleted, reported: msg.reported } });
});
