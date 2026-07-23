const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanJoinRequest = require("../models/clanJoinRequestModel");
const { withMongoTransaction } = require("./walletLedgerService");
const clanService = require("./clanService");
const clanMembershipService = require("./clanMembershipService");
const clanPermissionService = require("./clanPermissionService");
const clanRealtime = require("./clanRealtime");

async function requireActor(clanId, actorId, permission) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  const actor = await ClanMember.findOne({ clan: clanId, user: actorId }).lean();
  if (!actor) throw new ApiError("You are not a member of this clan", 403);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, permission, settings);
  return { clan, actor };
}

async function listRequests(actorId, clanId) {
  await requireActor(clanId, actorId, "acceptRequests");
  const rows = await ClanJoinRequest.find({ clan: clanId, status: "pending" })
    .populate("user", "name profileImg")
    .sort({ createdAt: 1 })
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    userId: String(r.user?._id || r.user),
    name: r.user?.name || null,
    avatar: r.user?.profileImg || null,
    message: r.message || "",
    createdAt: r.createdAt,
  }));
}

async function acceptRequest(actorId, requestId) {
  const reqDoc = await ClanJoinRequest.findById(requestId);
  if (!reqDoc || reqDoc.status !== "pending") throw new ApiError("Request not found", 404);
  await requireActor(reqDoc.clan, actorId, "acceptRequests");

  const targetUserId = reqDoc.user;
  // Already in a clan? Resolve the stale request rather than erroring.
  const existing = await ClanMember.findOne({ user: targetUserId }).lean();
  if (existing) {
    reqDoc.status = "rejected";
    reqDoc.decidedBy = actorId;
    reqDoc.decidedAt = new Date();
    await reqDoc.save();
    throw new ApiError("Applicant already joined another clan", 409);
  }

  try {
    await withMongoTransaction((session) =>
      clanMembershipService.addMemberInternal(session, reqDoc.clan, targetUserId, "member")
    );
  } catch (err) {
    if (clanService.isDuplicateKey(err)) throw new ApiError("Applicant already belongs to a clan", 409);
    throw err;
  }
  reqDoc.status = "accepted";
  reqDoc.decidedBy = actorId;
  reqDoc.decidedAt = new Date();
  await reqDoc.save();

  clanRealtime.emitToClan(reqDoc.clan, "clan:member_update", {
    type: "joined",
    userId: String(targetUserId),
  });
  clanRealtime.emitToUser(targetUserId, "clan:request_accepted", { clanId: String(reqDoc.clan) });
  clanMembershipService.notify(targetUserId, {
    title: "تم قبول طلبك",
    subtitle: "تمت الموافقة على انضمامك إلى العشيرة",
    icon: "check",
    sourceType: "clan_request_accepted",
    sourceId: String(reqDoc._id),
    meta: { clanId: String(reqDoc.clan) },
  });
  return { status: "accepted" };
}

async function rejectRequest(actorId, requestId) {
  const reqDoc = await ClanJoinRequest.findById(requestId);
  if (!reqDoc || reqDoc.status !== "pending") throw new ApiError("Request not found", 404);
  await requireActor(reqDoc.clan, actorId, "rejectRequests");
  reqDoc.status = "rejected";
  reqDoc.decidedBy = actorId;
  reqDoc.decidedAt = new Date();
  await reqDoc.save();
  clanRealtime.emitToUser(reqDoc.user, "clan:request_rejected", { clanId: String(reqDoc.clan) });
  clanMembershipService.notify(reqDoc.user, {
    title: "تم رفض طلبك",
    subtitle: "لم تتم الموافقة على انضمامك إلى العشيرة",
    icon: "warning",
    sourceType: "clan_request_rejected",
    sourceId: String(reqDoc._id),
    meta: { clanId: String(reqDoc.clan) },
  });
  return { status: "rejected" };
}

async function cancelMyRequest(userId, requestId) {
  const reqDoc = await ClanJoinRequest.findById(requestId);
  if (!reqDoc || String(reqDoc.user) !== String(userId)) throw new ApiError("Request not found", 404);
  if (reqDoc.status !== "pending") return { status: reqDoc.status };
  reqDoc.status = "cancelled";
  reqDoc.decidedAt = new Date();
  await reqDoc.save();
  return { status: "cancelled" };
}

async function listMyRequests(userId) {
  const rows = await ClanJoinRequest.find({ user: userId, status: "pending" })
    .populate("clan", "name tag logo")
    .sort({ createdAt: -1 })
    .lean();
  return rows
    .filter((r) => r.clan)
    .map((r) => ({
      id: String(r._id),
      clanId: String(r.clan._id),
      clanName: r.clan.name,
      clanTag: r.clan.tag,
      createdAt: r.createdAt,
    }));
}

module.exports = {
  listRequests,
  acceptRequest,
  rejectRequest,
  cancelMyRequest,
  listMyRequests,
};
