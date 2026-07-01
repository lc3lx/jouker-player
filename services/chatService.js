const ApiError = require("../utils/apiError");
const ChatMessage = require("../models/chatMessageModel");
const UserBlock = require("../models/userBlockModel");
const auditService = require("./auditService");

let socialIo = null;

function setSocialIo(io) {
  socialIo = io;
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
}) {
  const text = String(body || "").trim();
  const em = emoji ? String(emoji).slice(0, 32) : null;
  if (!text && !em) throw new ApiError("Message body required", 400);

  await assertCanMessage(senderId, channel, channelId, recipientId);

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
    createdAt: msg.createdAt,
  };

  if (socialIo) {
    if (channel === "private" || channel === "friend") {
      socialIo.to(`user:${String(senderId)}`).emit("chat:message", payload);
      socialIo.to(`user:${String(recipientId)}`).emit("chat:message", payload);
    } else {
      socialIo.to(roomForChannel(channel, channelId)).emit("chat:message", payload);
    }
  }

  return msg;
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
  if (!socialIo) return;
  socialIo.to(roomForChannel(channel, channelId)).emit("chat:typing", {
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
  sendMessage,
  getHistory,
  reportMessage,
  emitTyping,
  joinChannelRoom,
  roomForChannel,
};
