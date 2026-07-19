const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const FriendRequest = require("../models/friendRequestModel");
const Friendship = require("../models/friendshipModel");
const UserBlock = require("../models/userBlockModel");
const User = require("../models/userModel");
const auditService = require("./auditService");

function pairKey(a, b) {
  const x = String(a);
  const y = String(b);
  const sorted = x < y ? [x, y] : [y, x];
  return sorted.map((id) => new mongoose.Types.ObjectId(id));
}

async function isBlocked(userA, userB) {
  const count = await UserBlock.countDocuments({
    $or: [
      { blocker: userA, blocked: userB },
      { blocker: userB, blocked: userA },
    ],
  });
  return count > 0;
}

async function sendFriendRequest(fromId, toId, message = "") {
  if (String(fromId) === String(toId)) {
    throw new ApiError("Cannot friend yourself", 400);
  }
  if (await isBlocked(fromId, toId)) {
    throw new ApiError("Player is blocked", 403);
  }
  const target = await User.findById(toId).select("_id active");
  if (!target || !target.active) throw new ApiError("User not found", 404);

  const [u1, u2] = pairKey(fromId, toId);
  const existingFriend = await Friendship.findOne({ users: [u1, u2] });
  if (existingFriend) throw new ApiError("Already friends", 400);

  const pending = await FriendRequest.findOne({
    from: fromId,
    to: toId,
    status: "pending",
  });
  if (pending) throw new ApiError("Friend request already sent", 400);

  const req = await FriendRequest.create({
    from: fromId,
    to: toId,
    message: String(message || "").slice(0, 200),
    status: "pending",
  });

  await auditService.logEvent({
    event: "friend_request_sent",
    actor: fromId,
    targetUser: toId,
    meta: { requestId: String(req._id) },
  });

  const fromUser = await User.findById(fromId).select("name").lean();
  const { recordFriendRequestNotification } = require("./notificationService");
  recordFriendRequestNotification(req.toObject?.() || req, fromUser).catch(() => {});

  return req;
}

async function acceptFriendRequest(userId, requestId) {
  const req = await FriendRequest.findById(requestId);
  if (!req || String(req.to) !== String(userId)) {
    throw new ApiError("Friend request not found", 404);
  }
  if (req.status !== "pending") throw new ApiError("Request is not pending", 400);

  req.status = "accepted";
  req.respondedAt = new Date();
  await req.save();

  const [u1, u2] = pairKey(req.from, req.to);
  const friendship = await Friendship.findOneAndUpdate(
    { users: [u1, u2] },
    { $setOnInsert: { users: [u1, u2], createdAt: new Date() } },
    { upsert: true, new: true }
  );

  await FriendRequest.updateMany(
    { from: req.from, to: req.to, status: "pending", _id: { $ne: req._id } },
    { $set: { status: "cancelled", respondedAt: new Date() } }
  );

  await auditService.logEvent({
    event: "friend_request_accepted",
    actor: userId,
    targetUser: req.from,
    meta: { friendshipId: String(friendship._id) },
  });

  return friendship;
}

async function rejectFriendRequest(userId, requestId) {
  const req = await FriendRequest.findById(requestId);
  if (!req || String(req.to) !== String(userId)) {
    throw new ApiError("Friend request not found", 404);
  }
  if (req.status !== "pending") throw new ApiError("Request is not pending", 400);
  req.status = "rejected";
  req.respondedAt = new Date();
  await req.save();
  await auditService.logEvent({
    event: "friend_request_rejected",
    actor: userId,
    targetUser: req.from,
  });
  return req;
}

async function cancelFriendRequest(userId, requestId) {
  const req = await FriendRequest.findById(requestId);
  if (!req || String(req.from) !== String(userId)) {
    throw new ApiError("Friend request not found", 404);
  }
  if (req.status !== "pending") throw new ApiError("Request is not pending", 400);
  req.status = "cancelled";
  req.respondedAt = new Date();
  await req.save();
  return req;
}

async function removeFriend(userId, friendUserId) {
  const [u1, u2] = pairKey(userId, friendUserId);
  const res = await Friendship.deleteOne({ users: [u1, u2] });
  if (!res.deletedCount) throw new ApiError("Friendship not found", 404);
  await auditService.logEvent({
    event: "friend_removed",
    actor: userId,
    targetUser: friendUserId,
  });
  return { ok: true };
}

async function blockUser(blockerId, blockedId) {
  if (String(blockerId) === String(blockedId)) {
    throw new ApiError("Cannot block yourself", 400);
  }
  await removeFriend(blockerId, blockedId).catch(() => {});
  await FriendRequest.updateMany(
    {
      $or: [
        { from: blockerId, to: blockedId },
        { from: blockedId, to: blockerId },
      ],
      status: "pending",
    },
    { $set: { status: "cancelled", respondedAt: new Date() } }
  );
  await UserBlock.findOneAndUpdate(
    { blocker: blockerId, blocked: blockedId },
    { $setOnInsert: { blocker: blockerId, blocked: blockedId } },
    { upsert: true, new: true }
  );
  await auditService.logEvent({
    event: "user_blocked",
    actor: blockerId,
    targetUser: blockedId,
  });
  return { ok: true };
}

async function unblockUser(blockerId, blockedId) {
  const res = await UserBlock.deleteOne({ blocker: blockerId, blocked: blockedId });
  if (!res.deletedCount) throw new ApiError("Block not found", 404);
  await auditService.logEvent({
    event: "user_unblocked",
    actor: blockerId,
    targetUser: blockedId,
  });
  return { ok: true };
}

/**
 * Viewer-relative relationship for the player profile popup.
 * @returns {{ isSelf, isFriend, requestPending: 'none'|'outgoing'|'incoming', requestId, isBlocked }}
 */
async function getRelationship(viewerId, targetId) {
  const v = String(viewerId);
  const t = String(targetId);
  if (v === t) {
    return { isSelf: true, isFriend: false, requestPending: "none", requestId: null, isBlocked: false };
  }
  const [u1, u2] = pairKey(v, t);
  const [friendship, blocked, outReq, inReq] = await Promise.all([
    Friendship.findOne({ users: [u1, u2] }).lean(),
    isBlocked(v, t),
    FriendRequest.findOne({ from: v, to: t, status: "pending" }).lean(),
    FriendRequest.findOne({ from: t, to: v, status: "pending" }).lean(),
  ]);
  return {
    isSelf: false,
    isFriend: !!friendship,
    requestPending: outReq ? "outgoing" : inReq ? "incoming" : "none",
    requestId: outReq ? String(outReq._id) : inReq ? String(inReq._id) : null,
    isBlocked: blocked,
  };
}

async function listFriends(userId) {
  const rows = await Friendship.find({ users: userId }).lean();
  const friendIds = rows
    .map((r) => r.users.map(String).find((id) => id !== String(userId)))
    .filter(Boolean);
  const users = await User.find({ _id: { $in: friendIds } })
    .select("name profileImg country")
    .lean();
  return users.map((u) => ({
    userId: String(u._id),
    name: u.name,
    avatar: u.profileImg || null,
    country: u.country || null,
  }));
}

async function listPendingRequests(userId) {
  const incoming = await FriendRequest.find({ to: userId, status: "pending" })
    .sort({ createdAt: -1 })
    .populate("from", "name profileImg")
    .lean();
  const outgoing = await FriendRequest.find({ from: userId, status: "pending" })
    .sort({ createdAt: -1 })
    .populate("to", "name profileImg")
    .lean();
  return { incoming, outgoing };
}

module.exports = {
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
  listFriends,
  listPendingRequests,
  isBlocked,
  getRelationship,
};
