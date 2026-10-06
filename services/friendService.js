const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const FriendRequest = require("../models/friendRequestModel");
const Friendship = require("../models/friendshipModel");
const UserBlock = require("../models/userBlockModel");
const User = require("../models/userModel");
const auditService = require("./auditService");

/** How long a rejected sender waits before asking the same player again. */
const REJECT_COOLDOWN_MS = Math.max(
  0,
  parseInt(process.env.FRIEND_REQUEST_REJECT_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10)
);
/**
 * Open outgoing requests one player may hold. Player numbers are sequential, so
 * without a ceiling a script could request every account and push-notify the
 * whole player base.
 */
const MAX_PENDING_OUTGOING = Math.max(
  1,
  parseInt(process.env.FRIEND_REQUEST_MAX_PENDING || "100", 10)
);
/** Rows per direction returned by listPendingRequests. */
const PENDING_LIST_LIMIT = 100;

// The client shows these verbatim, and the app is Arabic.
const MSG = {
  self: "لا يمكنك إضافة نفسك",
  blocked: "لا يمكن إرسال طلب صداقة لهذا اللاعب",
  userNotFound: "اللاعب غير موجود",
  senderGone: "هذا اللاعب لم يعد متاحاً",
  alreadyFriends: "أنتما صديقان بالفعل",
  alreadySent: "أرسلت طلب صداقة لهذا اللاعب مسبقاً",
  cooldown: "لا يمكنك إرسال طلب جديد لهذا اللاعب الآن، حاول لاحقاً",
  tooManyPending: "لديك طلبات صداقة كثيرة بانتظار الرد — ألغِ بعضها أو انتظر الرد",
  requestNotFound: "طلب الصداقة غير موجود",
  notPending: "تمت معالجة هذا الطلب مسبقاً",
  friendshipNotFound: "هذا اللاعب ليس في قائمة أصدقائك",
  blockNotFound: "هذا اللاعب غير محظور",
  cannotBlockSelf: "لا يمكنك حظر نفسك",
};

let socialIo = null;

/** The /social namespace, wired by sockets/social.js at boot. */
function setSocialIo(io) {
  socialIo = io;
}

/**
 * Emit from the service rather than the socket handlers: the app calls the REST
 * routes, which used to tell nobody — a request only appeared once the
 * recipient happened to reload.
 */
function emitToUser(userId, event, payload) {
  if (!socialIo) return;
  socialIo.to(`user:${String(userId)}`).emit(event, payload);
}

/**
 * Strict: Mongoose also casts any 12-character string, and a malformed id used
 * to escape as a CastError — a 500 carrying Mongoose's message.
 */
function isObjectId(id) {
  if (id instanceof mongoose.Types.ObjectId) return true;
  return typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
}

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

/**
 * Send a friend request.
 *
 * Returns the request document. When `toId` had already asked `fromId`, that
 * request is accepted instead and returned with `status: "accepted"` — callers
 * read the status to tell "sent" from "you are now friends".
 */
async function sendFriendRequest(fromId, toId, message = "") {
  if (!isObjectId(toId)) throw new ApiError(MSG.userNotFound, 404);
  if (String(fromId) === String(toId)) throw new ApiError(MSG.self, 400);
  // Deliberately the same message whichever side did the blocking.
  if (await isBlocked(fromId, toId)) throw new ApiError(MSG.blocked, 403);
  // `active` is only absent on documents written before the field existed.
  // searchUsers treats those as active ({ $ne: false }), so requiring a truthy
  // value here made such a player findable but impossible to add.
  const target = await User.findById(toId).select("_id active").lean();
  if (!target || target.active === false) throw new ApiError(MSG.userNotFound, 404);

  const [u1, u2] = pairKey(fromId, toId);
  if (await Friendship.exists({ users: [u1, u2] })) {
    throw new ApiError(MSG.alreadyFriends, 400);
  }

  // They already asked you. The search dialog cannot know that, and filing a
  // mirrored request left both players waiting on each other.
  const theirs = await FriendRequest.findOne({ from: toId, to: fromId, status: "pending" })
    .select("_id")
    .lean();
  if (theirs) {
    try {
      await acceptFriendRequest(fromId, theirs._id);
      return FriendRequest.findById(theirs._id);
    } catch (e) {
      // Withdrawn between the read and the accept — ask the ordinary way.
      if (!(e instanceof ApiError)) throw e;
    }
  }

  if (await FriendRequest.exists({ from: fromId, to: toId, status: "pending" })) {
    throw new ApiError(MSG.alreadySent, 400);
  }
  if (REJECT_COOLDOWN_MS > 0) {
    const recentlyRejected = await FriendRequest.exists({
      from: fromId,
      to: toId,
      status: "rejected",
      respondedAt: { $gt: new Date(Date.now() - REJECT_COOLDOWN_MS) },
    });
    // Without this, send → reject → send was an unlimited push to the target.
    if (recentlyRejected) throw new ApiError(MSG.cooldown, 429);
  }
  const open = await FriendRequest.countDocuments({ from: fromId, status: "pending" });
  if (open >= MAX_PENDING_OUTGOING) throw new ApiError(MSG.tooManyPending, 429);

  let req;
  try {
    req = await FriendRequest.create({
      from: fromId,
      to: toId,
      message: String(message || "").slice(0, 200),
      status: "pending",
    });
  } catch (e) {
    // The exists() check above is a read; two sends landing together both pass
    // it. The one-pending-per-direction index is what rejects the second.
    if (e?.code === 11000) throw new ApiError(MSG.alreadySent, 400);
    throw e;
  }

  await auditService.logEvent({
    event: "friend_request_sent",
    actor: fromId,
    targetUser: toId,
    meta: { requestId: String(req._id) },
  });

  const fromUser = await User.findById(fromId).select("name").lean();
  const { recordFriendRequestNotification } = require("./notificationService");
  recordFriendRequestNotification(req.toObject(), fromUser).catch(() => {});

  const requestId = String(req._id);
  emitToUser(toId, "friend:request", {
    requestId,
    fromUserId: String(fromId),
    fromName: fromUser?.name || null,
  });
  emitToUser(fromId, "friend:update", { requestId, status: "pending" });

  return req;
}

/**
 * Atomically answer one pending request.
 *
 * `side` is the end of the request the caller must be on: "to" answers it,
 * "from" withdraws it. This used to be read → check → save, so an accept and a
 * cancel landing together both succeeded: the sender was told "cancelled" while
 * a friendship was created behind them.
 */
async function settleRequest(userId, requestId, side, status) {
  if (!isObjectId(String(requestId))) throw new ApiError(MSG.requestNotFound, 404);
  const req = await FriendRequest.findOneAndUpdate(
    { _id: requestId, [side]: userId, status: "pending" },
    { $set: { status, respondedAt: new Date() } },
    { new: true }
  );
  if (req) return req;
  const exists = await FriendRequest.exists({ _id: requestId, [side]: userId });
  throw exists
    ? new ApiError(MSG.notPending, 400)
    : new ApiError(MSG.requestNotFound, 404);
}

async function acceptFriendRequest(userId, requestId) {
  if (!isObjectId(String(requestId))) throw new ApiError(MSG.requestNotFound, 404);
  const pending = await FriendRequest.findOne({ _id: requestId, to: userId })
    .select("from status")
    .lean();
  if (!pending) throw new ApiError(MSG.requestNotFound, 404);
  if (pending.status !== "pending") throw new ApiError(MSG.notPending, 400);

  // A deleted or deactivated sender would otherwise become a friendship with
  // nobody in it — listFriends hides the row, but it never goes away.
  const sender = await User.findById(pending.from).select("_id active").lean();
  if (!sender || sender.active === false) {
    await FriendRequest.updateOne(
      { _id: requestId, status: "pending" },
      { $set: { status: "cancelled", respondedAt: new Date() } }
    );
    throw new ApiError(MSG.senderGone, 404);
  }

  const req = await settleRequest(userId, requestId, "to", "accepted");

  const [u1, u2] = pairKey(req.from, req.to);
  let friendship;
  try {
    friendship = await Friendship.findOneAndUpdate(
      { users: [u1, u2] },
      { $setOnInsert: { users: [u1, u2], createdAt: new Date() } },
      { upsert: true, new: true }
    );
  } catch (e) {
    // Two accepts racing (or mirrored A→B and B→A requests accepted at once)
    // both upsert the same pair. The unique pair index rejects the loser — the
    // friendship exists either way, so read it back instead of failing.
    if (e?.code === 11000) friendship = await Friendship.findOne({ users: [u1, u2] });
    if (!friendship) {
      // Reopen it: "accepted" with no friendship behind it is a dead end the
      // player could never retry from.
      await FriendRequest.updateOne(
        { _id: req._id, status: "accepted" },
        { $set: { status: "pending" }, $unset: { respondedAt: 1 } }
      ).catch(() => {});
      throw e;
    }
  }

  // Clear pending requests in BOTH directions. Cancelling only from→to left a
  // mirrored request from the new friend sitting in the list forever, offering
  // to befriend someone who already is a friend.
  await FriendRequest.updateMany(
    {
      status: "pending",
      _id: { $ne: req._id },
      $or: [
        { from: req.from, to: req.to },
        { from: req.to, to: req.from },
      ],
    },
    { $set: { status: "cancelled", respondedAt: new Date() } }
  );

  await auditService.logEvent({
    event: "friend_request_accepted",
    actor: userId,
    targetUser: req.from,
    meta: { friendshipId: String(friendship._id) },
  });

  const { recordFriendAcceptedNotification } = require("./notificationService");
  User.findById(userId)
    .select("name")
    .lean()
    .then((accepter) => recordFriendAcceptedNotification(req.toObject(), accepter))
    .catch(() => {});

  const settledId = String(req._id);
  emitToUser(req.from, "friend:added", { userId: String(req.to), requestId: settledId });
  emitToUser(req.to, "friend:added", { userId: String(req.from), requestId: settledId });

  return friendship;
}

async function rejectFriendRequest(userId, requestId) {
  const req = await settleRequest(userId, requestId, "to", "rejected");
  await auditService.logEvent({
    event: "friend_request_rejected",
    actor: userId,
    targetUser: req.from,
  });
  const payload = { requestId: String(req._id), status: "rejected" };
  emitToUser(req.from, "friend:update", payload);
  emitToUser(req.to, "friend:update", payload);
  return req;
}

async function cancelFriendRequest(userId, requestId) {
  const req = await settleRequest(userId, requestId, "from", "cancelled");
  await auditService.logEvent({
    event: "friend_request_cancelled",
    actor: userId,
    targetUser: req.to,
  });
  // The recipient's tile has to disappear, or accepting it 404s.
  const payload = { requestId: String(req._id), status: "cancelled" };
  emitToUser(req.to, "friend:update", payload);
  emitToUser(req.from, "friend:update", payload);
  return req;
}

async function removeFriend(userId, friendUserId, { notify = true } = {}) {
  if (!isObjectId(String(friendUserId))) throw new ApiError(MSG.friendshipNotFound, 404);
  const [u1, u2] = pairKey(userId, friendUserId);
  const res = await Friendship.deleteOne({ users: [u1, u2] });
  if (!res.deletedCount) throw new ApiError(MSG.friendshipNotFound, 404);
  await auditService.logEvent({
    event: "friend_removed",
    actor: userId,
    targetUser: friendUserId,
  });
  emitToUser(userId, "friend:removed", { userId: String(friendUserId) });
  if (notify) emitToUser(friendUserId, "friend:removed", { userId: String(userId) });
  return { ok: true };
}

async function blockUser(blockerId, blockedId) {
  if (!isObjectId(String(blockedId))) throw new ApiError(MSG.userNotFound, 404);
  if (String(blockerId) === String(blockedId)) {
    throw new ApiError(MSG.cannotBlockSelf, 400);
  }
  // Not announced to the blocked player: a live "friend removed" the instant
  // they were blocked would tell them exactly what happened.
  await removeFriend(blockerId, blockedId, { notify: false }).catch(() => {});
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
  // The blocker's own lists lost the friend and any open request.
  emitToUser(blockerId, "friend:update", { userId: String(blockedId), status: "blocked" });
  return { ok: true };
}

async function unblockUser(blockerId, blockedId) {
  if (!isObjectId(String(blockedId))) throw new ApiError(MSG.blockNotFound, 404);
  const res = await UserBlock.deleteOne({ blocker: blockerId, blocked: blockedId });
  if (!res.deletedCount) throw new ApiError(MSG.blockNotFound, 404);
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
    .select("name profileImg country playerId")
    .lean();
  return users.map((u) => ({
    userId: String(u._id),
    name: u.name,
    avatar: u.profileImg || null,
    country: u.country || null,
    playerId: typeof u.playerId === "number" ? u.playerId : null,
  }));
}

/**
 * A deleted account populates as null and a deactivated one is still there; both
 * rendered as a nameless "لاعب" tile whose accept could only fail.
 */
function withLiveCounterpart(rows, field) {
  return rows
    .filter((r) => r[field] && r[field].active !== false)
    .map((r) => {
      const { active: _active, ...user } = r[field];
      return { ...r, [field]: user };
    });
}

async function listPendingRequests(userId) {
  const [incoming, outgoing] = await Promise.all([
    FriendRequest.find({ to: userId, status: "pending" })
      .sort({ createdAt: -1 })
      .limit(PENDING_LIST_LIMIT)
      .populate("from", "name profileImg playerId active")
      .lean(),
    FriendRequest.find({ from: userId, status: "pending" })
      .sort({ createdAt: -1 })
      .limit(PENDING_LIST_LIMIT)
      .populate("to", "name profileImg playerId active")
      .lean(),
  ]);
  return {
    incoming: withLiveCounterpart(incoming, "from"),
    outgoing: withLiveCounterpart(outgoing, "to"),
  };
}

/**
 * Search players to add as friends — by player number, name, email or user id.
 *
 * The response deliberately does NOT include the target's email. Player numbers
 * are sequential, so returning email here would turn this endpoint into an
 * enumeration oracle: walk 1001 upward and harvest a name and an email address
 * for the entire player base. The ObjectId branch was effectively unguessable,
 * so this exposure is created by the numeric ids and has to be closed with them.
 */
async function searchUsers(viewerId, query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const base = {
    _id: { $ne: viewerId },
    active: { $ne: false },
  };

  // An exact player number is looked up on its own and put first: searching
  // "1001" should lead with player 1001, not with whoever happens to have 1001
  // inside their name.
  const exactRows = [];
  if (/^\d{1,9}$/.test(q)) {
    const byNumber = await User.findOne({ ...base, playerId: Number(q) })
      .select("name profileImg playerId")
      .lean();
    if (byNumber) exactRows.push(byNumber);
  } else if (q.length < 2) {
    // Short non-numeric queries stay blocked; a bare number is now meaningful.
    return [];
  }

  const or = [];
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  or.push({ name: { $regex: escaped, $options: "i" } });
  or.push({ email: { $regex: escaped, $options: "i" } });

  if (mongoose.Types.ObjectId.isValid(q)) {
    const oid = new mongoose.Types.ObjectId(q);
    if (String(oid) === q) {
      or.push({ _id: oid });
    }
  }

  const rows = await User.find({ ...base, $or: or })
    .select("name profileImg playerId")
    .limit(12)
    .lean();

  const seen = new Set(exactRows.map((u) => String(u._id)));
  const merged = [...exactRows, ...rows.filter((u) => !seen.has(String(u._id)))];

  return merged.slice(0, 12).map((u) => ({
    id: String(u._id),
    name: u.name,
    avatar: u.profileImg || null,
    playerId: typeof u.playerId === "number" ? u.playerId : null,
  }));
}

/** Send a friend request to whoever holds this player number. */
async function sendFriendRequestByPlayerId(fromId, playerId, message) {
  const n = Number(playerId);
  if (!Number.isInteger(n) || n < 1) {
    throw new ApiError("رقم لاعب غير صالح", 400);
  }
  const target = await User.findOne({ playerId: n }).select("_id").lean();
  if (!target) throw new ApiError("لا يوجد لاعب بهذا الرقم", 404);
  return sendFriendRequest(fromId, target._id, message);
}

module.exports = {
  setSocialIo,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
  listFriends,
  listPendingRequests,
  searchUsers,
  sendFriendRequestByPlayerId,
  isBlocked,
  getRelationship,
};
