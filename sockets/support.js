const jwt = require("jsonwebtoken");
const User = require("../models/userModel");
const logger = require("../utils/logger");
const { getTokenFromHandshake } = require("../utils/socketAuth");
const {
  setSupportIo,
  isStaffRole,
  getOrCreateOpenTicket,
  sendSupportMessage,
  getTicketMessages,
  markTicketRead,
  listAdminTickets,
  joinTicketRoom,
  joinStaffRoom,
  serializeTicket,
} = require("../services/supportService");

function initSupport(io) {
  const nsp = io.of("/support");
  setSupportIo(nsp);

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

  nsp.on("connection", (socket) => {
    const uid = socket.userId;
    const role = socket.userRole;
    socket.join(`user:${uid}`);
    if (isStaffRole(role)) joinStaffRoom(socket);

    socket.emit("support:connected", {
      userId: uid,
      role,
      isStaff: isStaffRole(role),
    });

    socket.on("support:open_ticket", async (payload = {}, ack) => {
      try {
        const ticket = await getOrCreateOpenTicket(uid, payload.subject);
        joinTicketRoom(socket, ticket._id);
        const messages = await getTicketMessages(ticket._id, uid, role, { limit: 80 });
        const data = {
          ticket: serializeTicket(ticket, role),
          messages,
        };
        if (typeof ack === "function") ack({ ok: true, ...data });
        socket.emit("support:ticket_opened", data);
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("support:join_ticket", async ({ ticketId } = {}, ack) => {
      try {
        if (!ticketId) throw new Error("ticketId required");
        joinTicketRoom(socket, ticketId);
        const messages = await getTicketMessages(ticketId, uid, role, { limit: 80 });
        await markTicketRead(ticketId, uid, role);
        if (typeof ack === "function") ack({ ok: true, messages });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("support:send", async ({ ticketId, body } = {}, ack) => {
      try {
        if (!ticketId) throw new Error("ticketId required");
        const message = await sendSupportMessage({
          ticketId,
          senderId: uid,
          senderRole: role,
          body: body || "",
        });
        if (typeof ack === "function") ack({ ok: true, message });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("support:typing", ({ ticketId, typing } = {}) => {
      if (!ticketId) return;
      socket.to(`ticket:${String(ticketId)}`).emit("support:typing", {
        ticketId: String(ticketId),
        userId: uid,
        userName: socket.userName,
        typing: !!typing,
        isStaff: isStaffRole(role),
      });
    });

    socket.on("support:admin_list", async ({ status = "open", page = 1 } = {}, ack) => {
      if (!isStaffRole(role)) {
        if (typeof ack === "function") ack({ ok: false, error: "Not allowed" });
        return;
      }
      try {
        const payload = await listAdminTickets({ status, page, limit: 50 });
        if (typeof ack === "function") ack({ ok: true, ...payload });
      } catch (e) {
        if (typeof ack === "function") ack({ ok: false, error: e.message });
      }
    });

    socket.on("disconnect", () => {
      logger.debug("support_socket_disconnect", { userId: uid });
    });
  });

  logger.info("support_socket_initialized");
  return nsp;
}

module.exports = { initSupport };
