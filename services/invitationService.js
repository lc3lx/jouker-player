const ApiError = require("../utils/apiError");
const GameInvitation = require("../models/gameInvitationModel");
const friendService = require("./friendService");
const auditService = require("./auditService");

const INVITE_TTL_MS = Math.max(
  60000,
  parseInt(process.env.GAME_INVITE_TTL_MS || String(5 * 60 * 1000), 10)
);

let socialIo = null;

function setSocialIo(io) {
  socialIo = io;
}

function emitToUser(userId, event, payload) {
  if (!socialIo) return;
  socialIo.to(`user:${String(userId)}`).emit(event, payload);
}

async function sendInvitation(fromId, {
  toUserId,
  gameType,
  tableId = null,
  tournamentId = null,
  tableNumber = null,
  displayName = null,
  joinPayload = null,
}) {
  if (String(fromId) === String(toUserId)) {
    throw new ApiError("Cannot invite yourself", 400);
  }
  if (await friendService.isBlocked(fromId, toUserId)) {
    throw new ApiError("Cannot invite blocked player", 403);
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await GameInvitation.create({
    from: fromId,
    to: toUserId,
    gameType,
    table: tableId,
    tournament: tournamentId,
    tableNumber,
    displayName,
    joinPayload,
    status: "pending",
    expiresAt,
  });

  const payload = {
    invitationId: String(invite._id),
    fromUserId: String(fromId),
    gameType,
    tableId: tableId ? String(tableId) : null,
    tournamentId: tournamentId ? String(tournamentId) : null,
    tableNumber,
    displayName,
    joinPayload,
    expiresAt: expiresAt.toISOString(),
    message: displayName
      ? `${displayName} invited you`
      : `Player invited you to ${gameType}`,
  };

  emitToUser(toUserId, "invitation:received", payload);

  await auditService.logEvent({
    event: "game_invitation_sent",
    actor: fromId,
    targetUser: toUserId,
    table: tableId,
    tournament: tournamentId,
    meta: { invitationId: String(invite._id), gameType },
  });

  return invite;
}

async function respondInvitation(userId, invitationId, accept) {
  const invite = await GameInvitation.findById(invitationId);
  if (!invite || String(invite.to) !== String(userId)) {
    throw new ApiError("Invitation not found", 404);
  }
  if (invite.status !== "pending") throw new ApiError("Invitation is not pending", 400);
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    invite.status = "expired";
    await invite.save();
    throw new ApiError("Invitation expired", 410);
  }

  invite.status = accept ? "accepted" : "declined";
  invite.respondedAt = new Date();
  await invite.save();

  emitToUser(invite.from, accept ? "invitation:accepted" : "invitation:declined", {
    invitationId: String(invite._id),
    byUserId: String(userId),
    gameType: invite.gameType,
    tableId: invite.table ? String(invite.table) : null,
  });

  await auditService.logEvent({
    event: accept ? "game_invitation_accepted" : "game_invitation_declined",
    actor: userId,
    targetUser: invite.from,
    table: invite.table,
    meta: { invitationId: String(invite._id) },
  });

  return invite;
}

async function cancelInvitation(userId, invitationId) {
  const invite = await GameInvitation.findById(invitationId);
  if (!invite || String(invite.from) !== String(userId)) {
    throw new ApiError("Invitation not found", 404);
  }
  if (invite.status !== "pending") throw new ApiError("Invitation is not pending", 400);
  invite.status = "cancelled";
  invite.respondedAt = new Date();
  await invite.save();
  return invite;
}

async function listPendingInvitations(userId) {
  const now = new Date();
  return GameInvitation.find({
    to: userId,
    status: "pending",
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .populate("from", "name profileImg")
    .lean();
}

module.exports = {
  setSocialIo,
  sendInvitation,
  respondInvitation,
  cancelInvitation,
  listPendingInvitations,
  INVITE_TTL_MS,
};
