const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const logger = require("../utils/logger");
const { getTokenFromHandshake } = require("../utils/socketAuth");
const {
  setDepositIo,
  ticketRoom,
  markAgentOnline,
  markAgentOffline,
  isStaffRole,
  getDepositProfile,
  assertTicketAccess,
  sendDepositMessage,
  getTicketMessagesForViewer,
  markTicketReadForViewer,
} = require("../services/agentDepositService");

/**
 * `/deposit` namespace — private per-ticket rooms between a user and their
 * assigned agent (staff may join any). Agents connected here count as online
 * for the agent cards.
 */
function initDeposit(io) {
  const nsp = io.of("/deposit");
  setDepositIo(nsp);

  nsp.use(async (socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      const user = await User.findById(decoded.userId).select("name role active profileImg");
      if (!user || user.active === false) return next(new Error("User not found"));
      socket.userId = String(user._id);
      socket.userRole = user.role || "user";
      socket.userName = user.name || "مستخدم";
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  nsp.on("connection", async (socket) => {
    const uid = socket.userId;
    const role = socket.userRole;
    socket.join(`user:${uid}`);

    // agents show as online while connected to this namespace
    let isAgent = false;
    try {
      isAgent = !!(await getDepositProfile(uid));
    } catch (_) {
      isAgent = false;
    }
    if (isAgent) {
      socket.isDepositAgent = true;
      markAgentOnline(uid);
      nsp.emit("deposit:agent_presence", { agentUserId: uid, online: true });
    }

    socket.emit("deposit:connected", {
      userId: uid,
      role,
      isAgent,
      isStaff: isStaffRole(role),
    });

    socket.on("deposit:join_ticket", async ({ ticketId } = {}, ack) => {
      try {
        if (!ticketId) throw new Error("ticketId required");
        await assertTicketAccess(ticketId, uid, role);
        socket.join(ticketRoom(ticketId));
        const messages = await getTicketMessagesForViewer(ticketId, uid, role, { limit: 30 });
        await markTicketReadForViewer(ticketId, uid, role);
        if (typeof ack === "function") ack({ ok: true, messages });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("deposit:leave_ticket", ({ ticketId } = {}) => {
      if (ticketId) socket.leave(ticketRoom(ticketId));
    });

    socket.on("deposit:send", async ({ ticketId, body } = {}, ack) => {
      try {
        if (!ticketId) throw new Error("ticketId required");
        const message = await sendDepositMessage({
          ticketId,
          senderId: uid,
          role,
          body: body || "",
        });
        if (typeof ack === "function") ack({ ok: true, message });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("deposit:typing", ({ ticketId, typing } = {}) => {
      if (!ticketId) return;
      socket.to(ticketRoom(ticketId)).emit("deposit:typing", {
        ticketId: String(ticketId),
        userId: uid,
        userName: socket.userName,
        typing: !!typing,
      });
    });

    socket.on("deposit:read", async ({ ticketId } = {}, ack) => {
      try {
        if (!ticketId) throw new Error("ticketId required");
        await markTicketReadForViewer(ticketId, uid, role);
        if (typeof ack === "function") ack({ ok: true });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("disconnect", () => {
      if (socket.isDepositAgent) {
        markAgentOffline(uid);
        nsp.emit("deposit:agent_presence", { agentUserId: uid, online: false });
      }
      logger.debug("deposit_socket_disconnect", { userId: uid });
    });
  });

  logger.info("deposit_socket_initialized");
  return nsp;
}

module.exports = { initDeposit };
