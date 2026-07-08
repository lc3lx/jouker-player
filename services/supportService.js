const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const SupportTicket = require("../models/supportTicketModel");
const SupportMessage = require("../models/supportMessageModel");
const User = require("../models/userModel");
const { sanitizeBody } = require("../sockets/tableChat");
const { createNotification } = require("./notificationService");

let supportIo = null;

function setSupportIo(io) {
  supportIo = io;
}

function isStaffRole(role) {
  return role === "admin" || role === "manager";
}

function ticketRoom(ticketId) {
  return `ticket:${String(ticketId)}`;
}

function serializeUserBrief(user) {
  if (!user) return null;
  const row = user._id ? user : { _id: user };
  return {
    id: String(row._id),
    name: row.name || "مستخدم",
    profileImg: row.profileImg || null,
    role: row.role || "user",
  };
}

function serializeMessage(row) {
  const sender = row.sender && typeof row.sender === "object" ? row.sender : null;
  return {
    id: String(row._id),
    ticketId: String(row.ticket),
    senderId: String(sender?._id || row.sender),
    senderName: sender?.name || "مستخدم",
    senderRole: row.senderRole || "user",
    senderAvatar: sender?.profileImg || null,
    body: row.body,
    createdAt: row.createdAt,
    isStaff: isStaffRole(row.senderRole),
  };
}

function serializeTicket(row, viewerRole = "user") {
  const user = row.user && typeof row.user === "object" ? row.user : null;
  const assigned =
    row.assignedTo && typeof row.assignedTo === "object" ? row.assignedTo : null;
  return {
    id: String(row._id),
    subject: row.subject || "طلب دعم فني",
    status: row.status,
    user: user
      ? {
          id: String(user._id),
          name: user.name || "مستخدم",
          profileImg: user.profileImg || null,
          email: isStaffRole(viewerRole) ? user.email || null : null,
        }
      : { id: String(row.user), name: "مستخدم" },
    assignedTo: assigned
      ? { id: String(assigned._id), name: assigned.name || "مشرف" }
      : null,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview || "",
    unreadCount: isStaffRole(viewerRole) ? row.unreadForStaff || 0 : row.unreadForUser || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertTicketAccess(ticketId, userId, role) {
  const ticket = await SupportTicket.findById(ticketId).populate("user", "name profileImg email role");
  if (!ticket) throw new ApiError("Ticket not found", 404);
  if (isStaffRole(role)) return ticket;
  if (String(ticket.user._id || ticket.user) !== String(userId)) {
    throw new ApiError("Not allowed to access this ticket", 403);
  }
  return ticket;
}

async function getOrCreateOpenTicket(userId, subject = null) {
  let ticket = await SupportTicket.findOne({ user: userId, status: { $in: ["open", "pending"] } })
    .sort({ updatedAt: -1 })
    .populate("user", "name profileImg email role")
    .populate("assignedTo", "name profileImg role")
    .lean();

  if (ticket) return ticket;

  ticket = await SupportTicket.create({
    user: userId,
    subject: subject ? sanitizeBody(subject).slice(0, 120) || "طلب دعم فني" : "طلب دعم فني",
    status: "open",
  });

  await SupportMessage.create({
    ticket: ticket._id,
    sender: userId,
    senderRole: "system",
    body: "مرحباً! صفّ فريق الدعم وسنرد عليك في أقرب وقت. اكتب مشكلتك بالتفصيل.",
    readByUser: true,
    readByStaff: false,
  });

  await SupportTicket.findByIdAndUpdate(ticket._id, {
    lastMessageAt: new Date(),
    lastMessagePreview: "مرحباً! صفّ فريق الدعم...",
    unreadForStaff: 1,
  });

  return SupportTicket.findById(ticket._id)
    .populate("user", "name profileImg email role")
    .populate("assignedTo", "name profileImg role")
    .lean();
}

async function sendSupportMessage({ ticketId, senderId, senderRole, body }) {
  const cleanBody = sanitizeBody(body);
  if (!cleanBody) throw new ApiError("Message body required", 400);

  const ticket = await assertTicketAccess(ticketId, senderId, senderRole);
  if (ticket.status === "closed") throw new ApiError("Ticket is closed", 400);

  const staff = isStaffRole(senderRole);
  const msg = await SupportMessage.create({
    ticket: ticket._id,
    sender: senderId,
    senderRole: staff ? senderRole : "user",
    body: cleanBody,
    readByUser: !staff,
    readByStaff: staff,
  });

  const preview = cleanBody.slice(0, 180);
  const updates = {
    lastMessageAt: msg.createdAt,
    lastMessagePreview: preview,
    status: staff ? "pending" : "open",
  };
  if (staff) {
    updates.unreadForUser = (ticket.unreadForUser || 0) + 1;
    updates.unreadForStaff = 0;
    if (!ticket.assignedTo) updates.assignedTo = senderId;
  } else {
    updates.unreadForStaff = (ticket.unreadForStaff || 0) + 1;
    updates.unreadForUser = 0;
  }

  await SupportTicket.findByIdAndUpdate(ticket._id, updates);

  const populated = await SupportMessage.findById(msg._id)
    .populate("sender", "name profileImg role")
    .lean();
  const payload = serializeMessage(populated);

  if (supportIo) {
    supportIo.to(ticketRoom(ticket._id)).emit("support:message", payload);
    supportIo.to("support:staff").emit("support:ticket_updated", {
      ticketId: String(ticket._id),
      preview,
      status: updates.status,
      unreadForStaff: updates.unreadForStaff ?? ticket.unreadForStaff,
    });
  }

  if (staff) {
    await createNotification({
      userId: ticket.user._id || ticket.user,
      category: "system",
      title: "رد من الدعم الفني",
      subtitle: preview,
      icon: "default",
      sourceType: "support",
      sourceId: String(ticket._id),
    });
  }

  return payload;
}

async function getTicketMessages(ticketId, userId, role, { before = null, limit = 80 } = {}) {
  await assertTicketAccess(ticketId, userId, role);
  const q = { ticket: ticketId };
  if (before) q.createdAt = { $lt: new Date(before) };
  const rows = await SupportMessage.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .populate("sender", "name profileImg role")
    .lean();
  return rows.reverse().map(serializeMessage);
}

async function markTicketRead(ticketId, userId, role) {
  const ticket = await assertTicketAccess(ticketId, userId, role);
  const staff = isStaffRole(role);
  if (staff) {
    await SupportTicket.findByIdAndUpdate(ticket._id, { unreadForStaff: 0 });
    await SupportMessage.updateMany(
      { ticket: ticket._id, readByStaff: false },
      { $set: { readByStaff: true } }
    );
  } else {
    await SupportTicket.findByIdAndUpdate(ticket._id, { unreadForUser: 0 });
    await SupportMessage.updateMany(
      { ticket: ticket._id, readByUser: false, senderRole: { $in: ["admin", "manager", "system"] } },
      { $set: { readByUser: true } }
    );
  }
  return { ok: true };
}

async function listAdminTickets({ status = "open", page = 1, limit = 40 } = {}) {
  const q = {};
  if (status && status !== "all") q.status = status;
  const skip = (Math.max(page, 1) - 1) * Math.min(limit, 100);
  const [rows, total] = await Promise.all([
    SupportTicket.find(q)
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(Math.min(limit, 100))
      .populate("user", "name profileImg email role")
      .populate("assignedTo", "name profileImg role")
      .lean(),
    SupportTicket.countDocuments(q),
  ]);
  return {
    tickets: rows.map((t) => serializeTicket(t, "admin")),
    total,
    page: Math.max(page, 1),
  };
}

async function closeTicket(ticketId, adminId) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new ApiError("Ticket not found", 404);
  if (ticket.status === "closed") return ticket;

  ticket.status = "closed";
  ticket.closedAt = new Date();
  ticket.closedBy = adminId;
  await ticket.save();

  const msg = await SupportMessage.create({
    ticket: ticket._id,
    sender: adminId,
    senderRole: "system",
    body: "تم إغلاق هذه المحادثة. يمكنك فتح تذكرة جديدة إذا احتجت مساعدة إضافية.",
    readByUser: false,
    readByStaff: true,
  });

  const populated = await SupportMessage.findById(msg._id)
    .populate("sender", "name profileImg role")
    .lean();
  const payload = serializeMessage(populated);

  if (supportIo) {
    supportIo.to(ticketRoom(ticket._id)).emit("support:message", payload);
    supportIo.to("support:staff").emit("support:ticket_updated", {
      ticketId: String(ticket._id),
      status: "closed",
    });
  }

  return ticket;
}

function joinTicketRoom(socket, ticketId) {
  socket.join(ticketRoom(ticketId));
}

function joinStaffRoom(socket) {
  socket.join("support:staff");
}

exports.setSupportIo = setSupportIo;
exports.isStaffRole = isStaffRole;
exports.ticketRoom = ticketRoom;
exports.serializeTicket = serializeTicket;
exports.getOrCreateOpenTicket = getOrCreateOpenTicket;
exports.sendSupportMessage = sendSupportMessage;
exports.getTicketMessages = getTicketMessages;
exports.markTicketRead = markTicketRead;
exports.listAdminTickets = listAdminTickets;
exports.closeTicket = closeTicket;
exports.joinTicketRoom = joinTicketRoom;
exports.joinStaffRoom = joinStaffRoom;

exports.getMyTicket = asyncHandler(async (req, res) => {
  const ticket = await getOrCreateOpenTicket(req.user._id, req.query.subject);
  res.status(200).json({
    status: "success",
    data: serializeTicket(ticket, req.user.role),
  });
});

exports.createTicket = asyncHandler(async (req, res) => {
  const existing = await SupportTicket.findOne({
    user: req.user._id,
    status: { $in: ["open", "pending"] },
  }).lean();
  if (existing) {
    throw new ApiError("لديك محادثة مفتوحة بالفعل", 400);
  }
  const ticket = await getOrCreateOpenTicket(req.user._id, req.body?.subject);
  res.status(201).json({
    status: "success",
    data: serializeTicket(ticket, req.user.role),
  });
});

exports.getMessages = asyncHandler(async (req, res) => {
  const messages = await getTicketMessages(
    req.params.ticketId,
    req.user._id,
    req.user.role,
    {
      before: req.query.before || null,
      limit: Number(req.query.limit) || 80,
    }
  );
  res.status(200).json({ status: "success", results: messages.length, data: messages });
});

exports.postMessage = asyncHandler(async (req, res) => {
  const message = await sendSupportMessage({
    ticketId: req.params.ticketId,
    senderId: req.user._id,
    senderRole: req.user.role,
    body: req.body?.body || "",
  });
  res.status(201).json({ status: "success", data: message });
});

exports.markRead = asyncHandler(async (req, res) => {
  await markTicketRead(req.params.ticketId, req.user._id, req.user.role);
  res.status(200).json({ status: "success" });
});

exports.adminListTickets = asyncHandler(async (req, res) => {
  const payload = await listAdminTickets({
    status: req.query.status || "open",
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 40,
  });
  res.status(200).json({ status: "success", ...payload, data: payload.tickets });
});

exports.adminCloseTicket = asyncHandler(async (req, res) => {
  await closeTicket(req.params.ticketId, req.user._id);
  res.status(200).json({ status: "success" });
});

exports.adminAssignTicket = asyncHandler(async (req, res) => {
  const ticket = await SupportTicket.findById(req.params.ticketId);
  if (!ticket) throw new ApiError("Ticket not found", 404);
  ticket.assignedTo = req.user._id;
  await ticket.save();
  res.status(200).json({
    status: "success",
    data: serializeTicket(
      await SupportTicket.findById(ticket._id)
        .populate("user", "name profileImg email role")
        .populate("assignedTo", "name profileImg role")
        .lean(),
      "admin"
    ),
  });
});

exports.adminOpenCounts = asyncHandler(async (req, res) => {
  const [open, pending, unread] = await Promise.all([
    SupportTicket.countDocuments({ status: "open" }),
    SupportTicket.countDocuments({ status: "pending" }),
    SupportTicket.countDocuments({ unreadForStaff: { $gt: 0 }, status: { $ne: "closed" } }),
  ]);
  res.status(200).json({
    status: "success",
    data: { open, pending, unread },
  });
});
