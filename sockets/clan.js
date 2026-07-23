const jwt = require("jsonwebtoken");
const { getTokenFromHandshake } = require("../socket/handlers/game.handlers");
const ClanMember = require("../models/clanMemberModel");
const chatService = require("../services/chatService");
const clanRealtime = require("../services/clanRealtime");
const logger = require("../utils/logger");

/**
 * The /clan realtime namespace: live clan chat + member/role/tournament broadcasts.
 * Mirrors sockets/social.js. Server→client pushes (member_update, role_update,
 * request_new, tournament_update, event_new, announcement) are emitted by the
 * services via clanRealtime; this file wires the namespace and handles chat.
 */
function initClan(io) {
  const nsp = io.of("/clan");
  clanRealtime.setClanIo(nsp);
  chatService.setClanIo(nsp);

  nsp.use((socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  nsp.on("connection", async (socket) => {
    const uid = String(socket.userId);
    socket.join(`user:${uid}`);

    // Auto-join the user's current clan rooms so they receive live events/chat.
    try {
      const member = await ClanMember.findOne({ user: uid }).select("clan").lean();
      if (member) {
        const clanId = String(member.clan);
        socket.data.clanId = clanId;
        socket.join(`clan:${clanId}`);
        chatService.joinChannelRoom(socket, "clan", clanId);
        socket.emit("clan:ready", { clanId });
      } else {
        socket.emit("clan:ready", { clanId: null });
      }
    } catch (e) {
      logger.warn("clan_socket_join_failed", { reason: e?.message || "unknown" });
    }

    // Explicit (re)join, e.g. right after creating/joining a clan.
    socket.on("clan:chat:join", async ({ clanId } = {}) => {
      if (!clanId) return;
      const isMember = await ClanMember.exists({ clan: clanId, user: uid });
      if (!isMember) return;
      socket.data.clanId = String(clanId);
      socket.join(`clan:${String(clanId)}`);
      chatService.joinChannelRoom(socket, "clan", clanId);
    });

    socket.on("clan:chat:send", async ({ clanId, body, emoji } = {}, ack) => {
      try {
        const target = clanId || socket.data.clanId;
        if (!target) throw new Error("No clan");
        const msg = await chatService.sendMessage({
          senderId: uid,
          channel: "clan",
          channelId: target,
          body,
          emoji,
        });
        if (typeof ack === "function") ack({ ok: true, id: String(msg._id) });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("clan:chat:typing", ({ clanId, typing } = {}) => {
      const target = clanId || socket.data.clanId;
      if (!target) return;
      chatService.emitTyping({ channel: "clan", channelId: target, userId: uid, typing });
    });
  });

  return nsp;
}

module.exports = { initClan };
