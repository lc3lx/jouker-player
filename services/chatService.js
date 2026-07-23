const ApiError = require("../utils/apiError");
const ChatMessage = require("../models/chatMessageModel");
const UserBlock = require("../models/userBlockModel");
const auditService = require("./auditService");

let socialIo = null;
let clanIo = null;

function setSocialIo(io) {
  socialIo = io;
}

/** The /clan namespace routes clan-channel messages (kept separate from /social). */
function setClanIo(io) {
  clanIo = io;
}

/** Which namespace broadcasts a given channel's messages. */
function ioForChannel(channel) {
  return channel === "clan" ? clanIo : socialIo;
}

function roomForChannel(channel, channelId) {
  return `chat:${channel}:${String(channelId)}`;
}

async function assertCanMessage(senderId, channel, channelId, recipientId = null) {
  if (channel === "private" || channel === "friend") {
    if (!recipientId) throw new ApiError("Recipient required", 400);
    const blocked = await UserBlock.countDocuments({
      $or: [
        { blocker: senderId, blocked: recipientId },
        { blocker: recipientId, blocked: senderId },
      ],
    });
    if (blocked) throw new ApiError("Messaging blocked", 403);
  } else if (channel === "clan") {
    // Only active members of the clan may post to its channel.
    const ClanMember = require("../models/clanMemberModel");
    const isMember = await ClanMember.exists({ clan: channelId, user: senderId });
    if (!isMember) throw new ApiError("You are not a member of this clan", 403);
  }
}

async function sendMessage({
  senderId,
  channel,
  channelId,
  body = "",
  emoji = null,
  recipientId = null,
  meta = null,
  system = false,
}) {
  const text = String(body || "").trim();
  const em = emoji ? String(emoji).slice(0, 32) : null;
  if (!text && !em) throw new ApiError("Message body required", 400);

  // System messages (join/leave/promotion/tournament) bypass membership/block
  // gating — the actor may already have left the clan.
  if (!system) await assertCanMessage(senderId, channel, channelId, recipientId);

  const msg = await ChatMessage.create({
    channel,
    channelId: String(channelId),
    sender: senderId,
    recipient: recipientId || undefined,
    body: text,
    emoji: em,
    meta,
  });

  const payload = {
    id: String(msg._id),
    channel,
    channelId: String(channelId),
    senderId: String(senderId),
    recipientId: recipientId ? String(recipientId) : null,
    body: text,
    emoji: em,
    system: !!(meta && meta.system) || !!system,
    meta: meta || null,
    createdAt: msg.createdAt,
  };

  const io = ioForChannel(channel);
  if (io) {
    if (channel === "private" || channel === "friend") {
      io.to(`user:${String(senderId)}`).emit("chat:message", payload);
      io.to(`user:${String(recipientId)}`).emit("chat:message", payload);
    } else {
      io.to(roomForChannel(channel, channelId)).emit("chat:message", payload);
    }
  }

  return msg;
}

/** Persist + broadcast a clan system line (join/leave/promotion/tournament). */
async function sendSystemMessage({ channel, channelId, actorId, body, meta = {} }) {
  return sendMessage({
    senderId: actorId,
    channel,
    channelId,
    body,
    meta: { ...meta, system: true },
    system: true,
  });
}

async function getHistory({ channel, channelId, before = null, limit = 50 }) {
  const q = { channel, channelId: String(channelId), deleted: false };
  if (before) q.createdAt = { $lt: new Date(before) };
  const rows = await ChatMessage.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .populate("sender", "name profileImg")
    .lean();
  return rows.reverse();
}

async function reportMessage(reporterId, messageId, reason = "") {
  const msg = await ChatMessage.findById(messageId);
  if (!msg) throw new ApiError("Message not found", 404);
  msg.reported = true;
  msg.reportReason = String(reason || "").slice(0, 500);
  await msg.save();
  await auditService.logEvent({
    event: "chat_reported",
    actor: reporterId,
    meta: { messageId: String(messageId), reason: msg.reportReason },
  });
  return msg;
}

function emitTyping({ channel, channelId, userId, typing }) {
  const io = ioForChannel(channel);
  if (!io) return;
  io.to(roomForChannel(channel, channelId)).emit("chat:typing", {
    channel,
    channelId: String(channelId),
    userId: String(userId),
    typing: !!typing,
  });
}

function joinChannelRoom(socket, channel, channelId) {
  socket.join(roomForChannel(channel, channelId));
}

module.exports = {
  setSocialIo,
  setClanIo,
  sendMessage,
  sendSystemMessage,
  getHistory,
  reportMessage,
  emitTyping,
  joinChannelRoom,
  roomForChannel,
};
