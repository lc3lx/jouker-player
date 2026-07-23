const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanInvitation = require("../models/clanInvitationModel");
const User = require("../models/userModel");
const { withMongoTransaction } = require("./walletLedgerService");
const clanService = require("./clanService");
const clanMembershipService = require("./clanMembershipService");
const clanPermissionService = require("./clanPermissionService");
const clanRealtime = require("./clanRealtime");

const INVITE_TTL_DAYS = 7;

async function sendInvitation(actorId, clanId, targetUserId, message = "") {
  if (!mongoose.isValidObjectId(clanId) || !mongoose.isValidObjectId(targetUserId)) {
    throw new ApiError("Invalid ids", 400);
  }
  if (String(actorId) === String(targetUserId)) throw new ApiError("Cannot invite yourself", 400);

  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  const actor = await ClanMember.findOne({ clan: clanId, user: actorId }).lean();
  if (!actor) throw new ApiError("You are not a member of this clan", 403);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, "invite", settings);

  if (clan.memberCount >= clan.maxMembers) throw new ApiError("Clan is full", 409);

  const target = await User.findById(targetUserId).select("_id name").lean();
  if (!target) throw new ApiError("User not found", 404);
  const targetMembership = await ClanMember.findOne({ user: targetUserId }).lean();
  if (targetMembership) throw new ApiError("User already belongs to a clan", 409);

  try {
    const [invite] = await ClanInvitation.create([
      {
        clan: clanId,
        invitedUser: targetUserId,
        invitedBy: actorId,
        message: String(message || "").slice(0, 200),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000),
      },
    ]);
    clanRealtime.emitToUser(targetUserId, "clan:invitation_new", {
      invitationId: String(invite._id),
      clanId: String(clanId),
      clanName: clan.name,
      clanTag: clan.tag,
    });
    clanMembershipService.notify(targetUserId, {
      title: "دعوة للانضمام لعشيرة",
      subtitle: `دعوة للانضمام إلى ${clan.name} [${clan.tag}]`,
      icon: "people",
      sourceType: "clan_invitation",
      sourceId: String(invite._id),
      meta: { clanId: String(clanId), invitationId: String(invite._id) },
    });
    return { id: String(invite._id), status: "pending" };
  } catch (err) {
    if (clanService.isDuplicateKey(err)) {
      throw new ApiError("User already has a pending invitation to this clan", 409);
    }
    throw err;
  }
}

async function acceptInvitation(userId, invitationId) {
  const invite = await ClanInvitation.findById(invitationId);
  if (!invite || String(invite.invitedUser) !== String(userId)) {
    throw new ApiError("Invitation not found", 404);
  }
  if (invite.status !== "pending") throw new ApiError("Invitation is no longer valid", 409);
  if (invite.expiresAt < new Date()) {
    invite.status = "expired";
    await invite.save();
    throw new ApiError("Invitation expired", 409);
  }

  const clanId = invite.clan;
  try {
    await withMongoTransaction((session) =>
      clanMembershipService.addMemberInternal(session, clanId, userId, "member")
    );
  } catch (err) {
    if (clanService.isDuplicateKey(err)) throw new ApiError("You already belong to a clan", 409);
    throw err;
  }
  invite.status = "accepted";
  invite.respondedAt = new Date();
  await invite.save();
  // Invalidate any other pending invitations for this now-claned user.
  await ClanInvitation.updateMany(
    { invitedUser: userId, status: "pending", _id: { $ne: invite._id } },
    { $set: { status: "cancelled", respondedAt: new Date() } }
  );

  clanRealtime.emitToClan(clanId, "clan:member_update", { type: "joined", userId: String(userId) });
  return { status: "joined", clanId: String(clanId) };
}

async function declineInvitation(userId, invitationId) {
  const invite = await ClanInvitation.findById(invitationId);
  if (!invite || String(invite.invitedUser) !== String(userId)) {
    throw new ApiError("Invitation not found", 404);
  }
  if (invite.status !== "pending") return { status: invite.status };
  invite.status = "declined";
  invite.respondedAt = new Date();
  await invite.save();
  return { status: "declined" };
}

async function cancelInvitation(actorId, invitationId) {
  const invite = await ClanInvitation.findById(invitationId);
  if (!invite) throw new ApiError("Invitation not found", 404);
  if (invite.status !== "pending") return { status: invite.status };
  // Inviter, or a member with invite permission, may cancel.
  if (String(invite.invitedBy) !== String(actorId)) {
    const actor = await ClanMember.findOne({ clan: invite.clan, user: actorId }).lean();
    const clan = await Clan.findById(invite.clan).lean();
    const settings = await clanService.getSettings();
    if (!actor || !clanPermissionService.can(clan, actor.role, "invite", settings)) {
      throw new ApiError("Not allowed to cancel this invitation", 403);
    }
  }
  invite.status = "cancelled";
  invite.respondedAt = new Date();
  await invite.save();
  return { status: "cancelled" };
}

async function listMyInvitations(userId) {
  const rows = await ClanInvitation.find({ invitedUser: userId, status: "pending" })
    .populate("clan", "name tag logo memberCount maxMembers")
    .populate("invitedBy", "name")
    .sort({ createdAt: -1 })
    .lean();
  return rows
    .filter((r) => r.clan)
    .map((r) => ({
      id: String(r._id),
      clanId: String(r.clan._id),
      clanName: r.clan.name,
      clanTag: r.clan.tag,
      clanLogo: r.clan.logo || null,
      invitedByName: r.invitedBy?.name || null,
      message: r.message || "",
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    }));
}

async function listClanInvitations(clanId) {
  const rows = await ClanInvitation.find({ clan: clanId, status: "pending" })
    .populate("invitedUser", "name profileImg")
    .sort({ createdAt: -1 })
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    userId: String(r.invitedUser?._id || r.invitedUser),
    name: r.invitedUser?.name || null,
    avatar: r.invitedUser?.profileImg || null,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

module.exports = {
  sendInvitation,
  acceptInvitation,
  declineInvitation,
  cancelInvitation,
  listMyInvitations,
  listClanInvitations,
};
