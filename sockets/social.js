const jwt = require("jsonwebtoken");
const { getTokenFromHandshake } = require("../socket/handlers/game.handlers");
const friendService = require("../services/friendService");
const invitationService = require("../services/invitationService");
const chatService = require("../services/chatService");
const presenceService = require("../services/presenceService");
const auditService = require("../services/auditService");
const logger = require("../utils/logger");

function initSocial(io, options = {}) {
  const nsp = io.of("/social");
  presenceService.setRedisClient(options.redis || null);
  invitationService.setSocialIo(nsp);
  chatService.setSocialIo(nsp);

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

  nsp.on("connection", (socket) => {
    const uid = String(socket.userId);
    socket.join(`user:${uid}`);

    void presenceService.setPresence(uid, { status: "online" }).then((p) => {
      socket.emit("presence:self", p);
    });

    socket.on("presence:heartbeat", async (payload = {}) => {
      const p = await presenceService.setPresence(uid, {
        status: payload.status || "online",
        gameType: payload.gameType || null,
        tableId: payload.tableId || null,
        lobbyId: payload.lobbyId || null,
        watching: !!payload.watching,
      });
      socket.emit("presence:self", p);
    });

    socket.on("presence:subscribe", async ({ userIds = [] } = {}) => {
      const batch = await presenceService.getPresenceBatch(userIds);
      socket.emit("presence:batch", batch);
    });

    socket.on("friend:send_request", async ({ toUserId, message } = {}, ack) => {
      try {
        const req = await friendService.sendFriendRequest(uid, toUserId, message);
        nsp.to(`user:${toUserId}`).emit("friend:request_received", {
          requestId: String(req._id),
          fromUserId: uid,
          message: req.message,
        });
        if (typeof ack === "function") ack({ ok: true, requestId: String(req._id) });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("friend:accept", async ({ requestId } = {}, ack) => {
      try {
        const friendship = await friendService.acceptFriendRequest(uid, requestId);
        const friendId = friendship.users.map(String).find((id) => id !== uid);
        nsp.to(`user:${friendId}`).emit("friend:accepted", { userId: uid });
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("invitation:respond", async ({ invitationId, accept } = {}, ack) => {
      try {
        const invite = await invitationService.respondInvitation(uid, invitationId, !!accept);
        if (typeof ack === "function") {
          ack({
            ok: true,
            invitation: {
              id: String(invite._id),
              gameType: invite.gameType,
              tableId: invite.table ? String(invite.table) : null,
              joinPayload: invite.joinPayload,
            },
          });
        }
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("chat:join", ({ channel, channelId } = {}) => {
      if (!channel || !channelId) return;
      chatService.joinChannelRoom(socket, channel, channelId);
    });

    socket.on("chat:send", async (payload = {}, ack) => {
      try {
        const msg = await chatService.sendMessage({
          senderId: uid,
          channel: payload.channel,
          channelId: payload.channelId,
          body: payload.body,
          emoji: payload.emoji,
          recipientId: payload.recipientId,
        });
        if (typeof ack === "function") ack({ ok: true, id: String(msg._id) });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("chat:typing", (payload = {}) => {
      chatService.emitTyping({
        channel: payload.channel,
        channelId: payload.channelId,
        userId: uid,
        typing: !!payload.typing,
      });
    });

    socket.on("disconnect", async () => {
      await presenceService.markOffline(uid);
      nsp.to(`user:${uid}`).emit("presence:update", { userId: uid, status: "offline" });
      await auditService.logEvent({ event: "socket_disconnect", actor: uid });
    });
  });

  logger.info("social_socket_initialized");
  return nsp;
}

module.exports = { initSocial };
