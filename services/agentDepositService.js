/**
 * Agent Deposit System — country agents credit users from their own wallet
 * after confirming an out-of-app payment, over a private per-ticket chat.
 *
 * Reuses: walletLedgerService (atomic transfer), notificationService (+push),
 * auditService (hash-chained log), tableChat sanitize/rate-limit, and the
 * support-ticket architecture for chat/rooms.
 */
const fs = require("fs");
const path = require("path");
const asyncHandler = require("express-async-handler");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");

const ApiError = require("../utils/apiError");
const DepositTicket = require("../models/depositTicketModel");
const DepositMessage = require("../models/depositMessageModel");
const AgentProfile = require("../models/agentProfileModel");
const User = require("../models/userModel");
const WalletTransaction = require("../models/walletTransactionModel");
const { COUNTRIES, findCountry } = require("../data/countries");
const { sanitizeBody, checkRate } = require("../sockets/tableChat");
const { uploadSingleImage } = require("../middlewares/uploadImageMiddleware");
const {
  withMongoTransaction,
  ledgerDeposit,
  ledgerWithdraw,
  getOrCreateWallet,
} = require("./walletLedgerService");
const { createNotification } = require("./notificationService");
const { sendPushToUser } = require("./pushService");
const { logEvent } = require("./auditService");
const { normalizeVipLevel } = require("../config/vipConfig");
const { priceUsdForLevel } = require("./vipPricingService");

const { ACTIVE_STATUSES } = DepositTicket;
const APPROVABLE_STATUSES = ["accepted", "waiting_payment", "receipt_uploaded"];
const TERMINAL_STATUSES = ["completed", "rejected", "cancelled"];
const MAX_ACTIVE_TICKETS_PER_USER = 3;

const RECEIPTS_DIR = path.join(__dirname, "..", "uploads", "receipts");
fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

// --- realtime plumbing (namespace + agent presence) -------------------------

let depositIo = null;
/** userId -> live socket count (agents only, for the online badge). */
const onlineAgents = new Map();

function setDepositIo(nsp) {
  depositIo = nsp;
}

function ticketRoom(ticketId) {
  return `ticket:${String(ticketId)}`;
}

function userRoom(userId) {
  return `user:${String(userId)}`;
}

function markAgentOnline(userId) {
  const key = String(userId);
  onlineAgents.set(key, (onlineAgents.get(key) || 0) + 1);
}

function markAgentOffline(userId) {
  const key = String(userId);
  const next = (onlineAgents.get(key) || 1) - 1;
  if (next <= 0) onlineAgents.delete(key);
  else onlineAgents.set(key, next);
}

function isAgentOnline(userId) {
  return onlineAgents.has(String(userId));
}

function isStaffRole(role) {
  return role === "admin" || role === "manager";
}

// --- serialization -----------------------------------------------------------

function briefUser(row) {
  if (!row) return null;
  const user = row._id ? row : { _id: row };
  return {
    id: String(user._id),
    name: user.name || "مستخدم",
    profileImg: user.profileImg || null,
  };
}

function serializeMessage(row) {
  const sender = row.sender && typeof row.sender === "object" ? row.sender : null;
  return {
    id: String(row._id),
    ticketId: String(row.ticket),
    senderId: String(sender?._id || row.sender),
    senderName: sender?.name || "مستخدم",
    senderAvatar: sender?.profileImg || null,
    senderRole: row.senderRole || "user",
    type: row.type || "text",
    body: row.body || "",
    imageUrl: row.imageUrl || "",
    createdAt: row.createdAt,
  };
}

function vipLevelLabelAr(level) {
  const map = {
    bronze: "برونز",
    silver: "فضة",
    gold: "ذهب",
    platinum: "بلاتينيوم",
  };
  return map[String(level || "").toLowerCase()] || level || "VIP";
}

function serializeTicket(row, viewer = "user") {
  const agentProfile =
    row.agentProfile && typeof row.agentProfile === "object" ? row.agentProfile : null;
  const ticketType = row.ticketType || "deposit";
  const isVip = ticketType === "vip";
  return {
    id: String(row._id),
    ticketType,
    status: row.status,
    country: row.country,
    amountRequested: row.amountRequested,
    amountApproved: row.amountApproved,
    vipLevel: row.vipLevel || null,
    priceUsd: row.priceUsd ?? null,
    vipLevelLabel: isVip ? vipLevelLabelAr(row.vipLevel) : null,
    currency: row.currency || "",
    paymentMethod: row.paymentMethod || "",
    user: briefUser(row.user),
    agentUser: briefUser(row.agentUser),
    agentName:
      agentProfile?.deposit?.displayName ||
      (row.agentUser && typeof row.agentUser === "object" ? row.agentUser.name : "") ||
      "وكيل",
    agentOnline: isAgentOnline(
      row.agentUser && typeof row.agentUser === "object" ? row.agentUser._id : row.agentUser
    ),
    receipts: (row.receipts || []).map((r) => ({ url: r.url, uploadedAt: r.uploadedAt })),
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview || "",
    unreadCount: viewer === "agent" ? row.unreadForAgent || 0 : row.unreadForUser || 0,
    closeReason: row.closeReason || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const TICKET_POPULATE = [
  { path: "user", select: "name profileImg" },
  { path: "agentUser", select: "name profileImg" },
  { path: "agentProfile", select: "deposit.displayName deposit.rating" },
];

async function loadTicket(ticketId) {
  const ticket = await DepositTicket.findById(ticketId).populate(TICKET_POPULATE);
  if (!ticket) throw new ApiError("الطلب غير موجود", 404);
  return ticket;
}

/** Viewer relationship to a ticket: 'user' | 'agent' | 'staff'. */
function viewerFor(ticket, userId, role) {
  if (String(ticket.user._id || ticket.user) === String(userId)) return "user";
  if (String(ticket.agentUser._id || ticket.agentUser) === String(userId)) return "agent";
  if (isStaffRole(role)) return "staff";
  return null;
}

async function assertTicketAccess(ticketId, userId, role) {
  const ticket = await loadTicket(ticketId);
  const viewer = viewerFor(ticket, userId, role);
  if (!viewer) throw new ApiError("غير مسموح بالوصول لهذا الطلب", 403);
  return { ticket, viewer };
}

// --- notifications / realtime helpers ---------------------------------------

// createNotification mirrors to FCM automatically (see notificationService).
async function notifyAndPush(userId, { title, subtitle, sourceType, sourceId }) {
  try {
    await createNotification({
      userId,
      category: "wallet",
      title,
      subtitle,
      icon: "wallet",
      sourceType,
      sourceId,
    });
  } catch (_) {
    /* never block the flow */
  }
}

function emitTicketUpdate(ticket, extra = {}) {
  if (!depositIo) return;
  const payload = {
    ticketId: String(ticket._id),
    status: ticket.status,
    ...extra,
  };
  depositIo.to(ticketRoom(ticket._id)).emit("deposit:ticket_updated", payload);
  depositIo.to(userRoom(ticket.user._id || ticket.user)).emit("deposit:ticket_updated", payload);
  depositIo
    .to(userRoom(ticket.agentUser._id || ticket.agentUser))
    .emit("deposit:ticket_updated", payload);
}

// --- chat core ---------------------------------------------------------------

/**
 * Shared message path (REST + socket + system events).
 * senderRole is derived from the ticket, not trusted from the caller.
 */
async function sendDepositMessage({
  ticketId,
  senderId,
  role = "user",
  body = "",
  type = "text",
  imageUrl = "",
  system = false,
}) {
  const { ticket, viewer } = system
    ? { ticket: await loadTicket(ticketId), viewer: "staff" }
    : await assertTicketAccess(ticketId, senderId, role);

  if (TERMINAL_STATUSES.includes(ticket.status) && !system) {
    throw new ApiError("هذه المحادثة مغلقة", 400);
  }

  if (!system) {
    const rate = checkRate(`deposit:${senderId}`);
    if (!rate.ok) throw new ApiError("رسائل كثيرة — انتظر قليلاً", 429);
  }

  const cleanBody = sanitizeBody(body);
  if (!cleanBody && type === "text") throw new ApiError("نص الرسالة مطلوب", 400);

  const senderRole = system
    ? "system"
    : viewer === "agent"
      ? "agent"
      : viewer === "staff"
        ? "admin"
        : "user";

  const fromAgentSide = senderRole === "agent" || senderRole === "admin";
  const msg = await DepositMessage.create({
    ticket: ticket._id,
    sender: senderId,
    senderRole,
    type: system ? "system" : type,
    body: cleanBody,
    imageUrl,
    readByUser: senderRole === "user",
    readByAgent: senderRole === "agent",
  });

  const preview =
    type === "image" ? "📷 صورة" : cleanBody.slice(0, 180) || "رسالة";
  const updates = {
    lastMessageAt: msg.createdAt,
    lastMessagePreview: preview,
  };
  if (!system) {
    if (fromAgentSide) {
      updates.unreadForUser = (ticket.unreadForUser || 0) + 1;
      updates.unreadForAgent = 0;
    } else {
      updates.unreadForAgent = (ticket.unreadForAgent || 0) + 1;
      updates.unreadForUser = 0;
    }
  }
  // Agent sharing payment details moves the request forward organically.
  if (senderRole === "agent" && ticket.status === "accepted") {
    updates.status = "waiting_payment";
  }
  await DepositTicket.updateOne({ _id: ticket._id }, updates);

  const populated = await DepositMessage.findById(msg._id)
    .populate("sender", "name profileImg")
    .lean();
  const payload = serializeMessage(populated);

  if (depositIo) {
    depositIo.to(ticketRoom(ticket._id)).emit("deposit:message", payload);
    emitTicketUpdate(
      { ...ticket.toObject(), status: updates.status || ticket.status },
      { preview }
    );
  }

  // Push (not in-app notification — that would flood) to the counterpart.
  if (!system) {
    const counterpart = fromAgentSide
      ? ticket.user._id || ticket.user
      : ticket.agentUser._id || ticket.agentUser;
    sendPushToUser(counterpart, {
      title: fromAgentSide ? "رد الوكيل عليك" : "رسالة جديدة من عميل",
      body: preview,
      data: { type: "deposit_message", ticketId: String(ticket._id) },
    });
  }

  return payload;
}

async function getTicketMessages(ticketId, userId, role, { before = null, limit = 30 } = {}) {
  await assertTicketAccess(ticketId, userId, role);
  const q = { ticket: ticketId };
  if (before) q.createdAt = { $lt: new Date(before) };
  const rows = await DepositMessage.find(q)
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 60))
    .populate("sender", "name profileImg")
    .lean();
  return rows.reverse().map(serializeMessage);
}

async function markTicketRead(ticketId, userId, role) {
  const { ticket, viewer } = await assertTicketAccess(ticketId, userId, role);
  if (viewer === "agent") {
    await DepositTicket.updateOne({ _id: ticket._id }, { unreadForAgent: 0 });
    await DepositMessage.updateMany(
      { ticket: ticket._id, readByAgent: false },
      { $set: { readByAgent: true } }
    );
  } else if (viewer === "user") {
    await DepositTicket.updateOne({ _id: ticket._id }, { unreadForUser: 0 });
    await DepositMessage.updateMany(
      { ticket: ticket._id, readByUser: false },
      { $set: { readByUser: true } }
    );
  }
  if (depositIo) {
    depositIo.to(ticketRoom(ticket._id)).emit("deposit:read", {
      ticketId: String(ticket._id),
      by: viewer,
    });
  }
  return { ok: true };
}

// --- agent guard --------------------------------------------------------------

async function getDepositProfile(userId) {
  return AgentProfile.findOne({
    user: userId,
    status: "approved",
    "deposit.enabled": true,
  });
}

const requireDepositAgent = asyncHandler(async (req, res, next) => {
  const profile = await getDepositProfile(req.user._id);
  if (!profile) throw new ApiError("لست وكيل إيداع معتمداً", 403);
  req.depositProfile = profile;
  next();
});

// ==============================================================================
// USER endpoints
// ==============================================================================

exports.listCountries = asyncHandler(async (req, res) => {
  const codes = await AgentProfile.distinct("deposit.countries", {
    status: "approved",
    "deposit.enabled": true,
  });
  const codeSet = new Set(codes.map((c) => String(c).toUpperCase()));
  const counts = await AgentProfile.aggregate([
    { $match: { status: "approved", "deposit.enabled": true } },
    { $unwind: "$deposit.countries" },
    { $group: { _id: "$deposit.countries", agents: { $sum: 1 } } },
  ]);
  const countByCode = new Map(counts.map((c) => [String(c._id).toUpperCase(), c.agents]));
  const data = COUNTRIES.filter((c) => codeSet.has(c.code)).map((c) => ({
    ...c,
    agents: countByCode.get(c.code) || 0,
  }));
  res.status(200).json({ status: "success", results: data.length, data });
});

exports.listAgents = asyncHandler(async (req, res) => {
  const country = String(req.params.country || "").toUpperCase();
  if (!findCountry(country)) throw new ApiError("دولة غير مدعومة", 400);

  const profiles = await AgentProfile.find({
    status: "approved",
    "deposit.enabled": true,
    "deposit.countries": country,
  })
    .populate("user", "name profileImg")
    .lean();

  const data = profiles.map((p) => ({
    agentProfileId: String(p._id),
    name: p.deposit?.displayName || p.user?.name || "وكيل",
    avatar: p.user?.profileImg || null,
    online: isAgentOnline(p.user?._id),
    paymentMethods: p.deposit?.paymentMethods || [],
    workingHours: p.deposit?.workingHours || "",
    rating: p.deposit?.rating ?? 5,
    totalDeposits: p.deposit?.stats?.totalDeposits || 0,
  }));
  // online agents first
  data.sort((a, b) => Number(b.online) - Number(a.online));
  res.status(200).json({ status: "success", results: data.length, data });
});

exports.createTicket = asyncHandler(async (req, res) => {
  const { agentProfileId, amount, paymentMethod = "", currency = "" } = req.body || {};
  const amountRequested = Math.round(Number(amount));
  if (!Number.isFinite(amountRequested) || amountRequested < 1) {
    throw new ApiError("المبلغ المطلوب غير صالح", 400);
  }

  const profile = await AgentProfile.findOne({
    _id: agentProfileId,
    status: "approved",
    "deposit.enabled": true,
  }).populate("user", "name profileImg");
  if (!profile) throw new ApiError("الوكيل غير متاح", 404);
  if (String(profile.user._id) === String(req.user._id)) {
    throw new ApiError("لا يمكنك فتح طلب مع نفسك", 400);
  }

  const country = (profile.deposit.countries || [])[0] || req.user.country || "";

  // one active ticket per user↔agent pair, and a small global cap
  const [pairActive, totalActive] = await Promise.all([
    DepositTicket.countDocuments({
      user: req.user._id,
      agentProfile: profile._id,
      status: { $in: ACTIVE_STATUSES },
    }),
    DepositTicket.countDocuments({
      user: req.user._id,
      status: { $in: ACTIVE_STATUSES },
    }),
  ]);
  if (pairActive > 0) throw new ApiError("لديك طلب مفتوح مع هذا الوكيل بالفعل", 400);
  if (totalActive >= MAX_ACTIVE_TICKETS_PER_USER) {
    throw new ApiError("لديك عدد كبير من الطلبات المفتوحة", 400);
  }

  const requestedCountry = String(req.body.country || country || "").toUpperCase();
  const ticket = await DepositTicket.create({
    user: req.user._id,
    agentProfile: profile._id,
    agentUser: profile.user._id,
    country: findCountry(requestedCountry) ? requestedCountry : country,
    amountRequested,
    currency: String(currency).slice(0, 12),
    paymentMethod: sanitizeBody(paymentMethod).slice(0, 60),
    meta: {
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    },
  });

  await sendDepositMessage({
    ticketId: ticket._id,
    senderId: req.user._id,
    system: true,
    body: `طلب إيداع جديد بقيمة ${amountRequested.toLocaleString("en-US")} — بانتظار موافقة الوكيل.`,
  });

  await notifyAndPush(profile.user._id, {
    title: "طلب إيداع جديد",
    subtitle: `${req.user.name || "عميل"} يطلب إيداع ${amountRequested.toLocaleString("en-US")}`,
    sourceType: "deposit_ticket",
    sourceId: String(ticket._id),
    data: { ticketId: String(ticket._id) },
  });

  const populated = await loadTicket(ticket._id);
  emitTicketUpdate(populated);
  res.status(201).json({ status: "success", data: serializeTicket(populated, "user") });
});

exports.createVipTicket = asyncHandler(async (req, res) => {
  const { agentProfileId, vipLevel: rawLevel, paymentMethod = "", currency = "" } = req.body || {};
  const level = normalizeVipLevel(rawLevel);
  if (!level) throw new ApiError("باقة VIP غير صالحة", 400);

  const priceUsd = await priceUsdForLevel(level);
  if (!Number.isFinite(priceUsd) || priceUsd < 0) {
    throw new ApiError("سعر الباقة غير متاح", 400);
  }

  const profile = await AgentProfile.findOne({
    _id: agentProfileId,
    status: "approved",
    "deposit.enabled": true,
  }).populate("user", "name profileImg");
  if (!profile) throw new ApiError("الوكيل غير متاح", 404);
  if (String(profile.user._id) === String(req.user._id)) {
    throw new ApiError("لا يمكنك فتح طلب مع نفسك", 400);
  }

  const country = (profile.deposit.countries || [])[0] || req.user.country || "";

  const [pairActive, totalVipActive] = await Promise.all([
    DepositTicket.countDocuments({
      user: req.user._id,
      agentProfile: profile._id,
      ticketType: "vip",
      status: { $in: ACTIVE_STATUSES },
    }),
    DepositTicket.countDocuments({
      user: req.user._id,
      ticketType: "vip",
      status: { $in: ACTIVE_STATUSES },
    }),
  ]);
  if (pairActive > 0) throw new ApiError("لديك طلب VIP مفتوح مع هذا الوكيل بالفعل", 400);
  if (totalVipActive > 0) throw new ApiError("لديك طلب VIP قيد المعالجة بالفعل", 400);

  const requestedCountry = String(req.body.country || country || "").toUpperCase();
  const levelLabel = vipLevelLabelAr(level);
  const ticket = await DepositTicket.create({
    user: req.user._id,
    agentProfile: profile._id,
    agentUser: profile.user._id,
    country: findCountry(requestedCountry) ? requestedCountry : country,
    ticketType: "vip",
    vipLevel: level,
    priceUsd,
    amountRequested: 0,
    currency: String(currency).slice(0, 12),
    paymentMethod: sanitizeBody(paymentMethod).slice(0, 60),
    meta: {
      ip: req.ip || "",
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    },
  });

  await sendDepositMessage({
    ticketId: ticket._id,
    senderId: req.user._id,
    system: true,
    body: `طلب شراء VIP ${levelLabel} ($${priceUsd.toFixed(2)}) — بانتظار موافقة الوكيل.`,
  });

  await notifyAndPush(profile.user._id, {
    title: "طلب شراء VIP جديد",
    subtitle: `${req.user.name || "عميل"} يطلب VIP ${levelLabel}`,
    sourceType: "vip_ticket",
    sourceId: String(ticket._id),
    data: { ticketId: String(ticket._id), vipLevel: level },
  });

  const populated = await loadTicket(ticket._id);
  emitTicketUpdate(populated);
  res.status(201).json({ status: "success", data: serializeTicket(populated, "user") });
});

exports.getMyTickets = asyncHandler(async (req, res) => {
  const rows = await DepositTicket.find({ user: req.user._id })
    .sort({ lastMessageAt: -1 })
    .limit(50)
    .populate(TICKET_POPULATE)
    .lean();
  res.status(200).json({
    status: "success",
    results: rows.length,
    data: rows.map((t) => serializeTicket(t, "user")),
  });
});

exports.getTicket = asyncHandler(async (req, res) => {
  const { ticket, viewer } = await assertTicketAccess(
    req.params.ticketId,
    req.user._id,
    req.user.role
  );
  res.status(200).json({
    status: "success",
    data: serializeTicket(ticket, viewer === "agent" ? "agent" : "user"),
  });
});

exports.getMessages = asyncHandler(async (req, res) => {
  const messages = await getTicketMessages(req.params.ticketId, req.user._id, req.user.role, {
    before: req.query.before || null,
    limit: Number(req.query.limit) || 30,
  });
  res.status(200).json({ status: "success", results: messages.length, data: messages });
});

exports.postMessage = asyncHandler(async (req, res) => {
  const message = await sendDepositMessage({
    ticketId: req.params.ticketId,
    senderId: req.user._id,
    role: req.user.role,
    body: req.body?.body || "",
  });
  res.status(201).json({ status: "success", data: message });
});

exports.markRead = asyncHandler(async (req, res) => {
  await markTicketRead(req.params.ticketId, req.user._id, req.user.role);
  res.status(200).json({ status: "success" });
});

exports.cancelTicket = asyncHandler(async (req, res) => {
  const updated = await DepositTicket.findOneAndUpdate(
    {
      _id: req.params.ticketId,
      user: req.user._id,
      status: { $in: ["pending", "accepted", "waiting_payment", "receipt_uploaded"] },
    },
    {
      status: "cancelled",
      closedAt: new Date(),
      closedBy: req.user._id,
      closeReason: sanitizeBody(req.body?.reason || "").slice(0, 300),
    },
    { new: true }
  ).populate(TICKET_POPULATE);
  if (!updated) throw new ApiError("لا يمكن إلغاء هذا الطلب", 400);

  await sendDepositMessage({
    ticketId: updated._id,
    senderId: req.user._id,
    system: true,
    body: "قام العميل بإلغاء الطلب.",
  });
  await notifyAndPush(updated.agentUser._id || updated.agentUser, {
    title: "تم إلغاء طلب إيداع",
    subtitle: "قام العميل بإلغاء طلبه",
    sourceType: "deposit_cancelled",
    sourceId: String(updated._id),
    data: { ticketId: String(updated._id) },
  });
  emitTicketUpdate(updated);
  res.status(200).json({ status: "success", data: serializeTicket(updated, "user") });
});

// --- receipt upload -----------------------------------------------------------

exports.uploadReceiptImage = uploadSingleImage("receipt");

exports.processReceiptImage = asyncHandler(async (req, res, next) => {
  if (!req.file) throw new ApiError("صورة الإيصال مطلوبة", 400);
  const filename = `receipt-${uuidv4()}-${Date.now()}.jpeg`;
  await sharp(req.file.buffer)
    .rotate()
    .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
    .toFormat("jpeg")
    .jpeg({ quality: 88 })
    .toFile(path.join(RECEIPTS_DIR, filename));
  req.receiptUrl = `uploads/receipts/${filename}`;
  next();
});

exports.uploadReceipt = asyncHandler(async (req, res) => {
  const { ticket, viewer } = await assertTicketAccess(
    req.params.ticketId,
    req.user._id,
    req.user.role
  );
  if (viewer !== "user") throw new ApiError("رفع الإيصال متاح للعميل فقط", 403);
  if (!APPROVABLE_STATUSES.includes(ticket.status) && ticket.status !== "pending") {
    throw new ApiError("لا يمكن رفع إيصال في حالة الطلب الحالية", 400);
  }
  if ((ticket.receipts || []).length >= 10) {
    throw new ApiError("تم بلوغ الحد الأقصى للإيصالات", 400);
  }

  await DepositTicket.updateOne(
    { _id: ticket._id },
    {
      $push: { receipts: { url: req.receiptUrl, uploadedAt: new Date() } },
      $set: { status: "receipt_uploaded" },
    }
  );

  const message = await sendDepositMessage({
    ticketId: ticket._id,
    senderId: req.user._id,
    role: req.user.role,
    type: "image",
    imageUrl: req.receiptUrl,
    body: "إيصال الدفع",
  });

  await notifyAndPush(ticket.agentUser._id || ticket.agentUser, {
    title: "تم رفع إيصال دفع",
    subtitle: `${req.user.name || "عميل"} رفع إيصال الدفع — بانتظار المراجعة`,
    sourceType: "deposit_receipt",
    sourceId: String(ticket._id),
    data: { ticketId: String(ticket._id) },
  });

  const updated = await loadTicket(ticket._id);
  emitTicketUpdate(updated);
  res.status(201).json({
    status: "success",
    data: { message, ticket: serializeTicket(updated, "user") },
  });
});

// ==============================================================================
// AGENT endpoints
// ==============================================================================

exports.requireDepositAgent = requireDepositAgent;

exports.getMyAgentProfile = asyncHandler(async (req, res) => {
  const profile = await getDepositProfile(req.user._id);
  if (!profile) throw new ApiError("لست وكيل إيداع معتمداً", 403);
  res.status(200).json({
    status: "success",
    data: {
      agentProfileId: String(profile._id),
      displayName: profile.deposit.displayName || req.user.name,
      countries: profile.deposit.countries || [],
      paymentMethods: profile.deposit.paymentMethods || [],
      workingHours: profile.deposit.workingHours || "",
      rating: profile.deposit.rating ?? 5,
      stats: profile.deposit.stats || { totalDeposits: 0, totalVolume: 0 },
    },
  });
});

const AGENT_FILTERS = {
  new: ["pending"],
  active: ["accepted", "waiting_payment"],
  review: ["receipt_uploaded", "reviewing"],
  completed: ["completed"],
  rejected: ["rejected", "cancelled"],
};

exports.getAgentTickets = asyncHandler(async (req, res) => {
  const filter = String(req.query.filter || "new");
  const statuses = AGENT_FILTERS[filter] || AGENT_FILTERS.new;
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const q = { agentUser: req.user._id, status: { $in: statuses } };
  const [rows, total, countRows] = await Promise.all([
    DepositTicket.find(q)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(TICKET_POPULATE)
      .lean(),
    DepositTicket.countDocuments(q),
    DepositTicket.aggregate([
      { $match: { agentUser: req.user._id } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = new Map(countRows.map((r) => [r._id, r.n]));
  const counts = {};
  for (const [key, list] of Object.entries(AGENT_FILTERS)) {
    counts[key] = list.reduce((sum, s) => sum + (byStatus.get(s) || 0), 0);
  }

  res.status(200).json({
    status: "success",
    results: rows.length,
    total,
    page,
    counts,
    data: rows.map((t) => serializeTicket(t, "agent")),
  });
});

exports.acceptTicket = asyncHandler(async (req, res) => {
  const updated = await DepositTicket.findOneAndUpdate(
    { _id: req.params.ticketId, agentUser: req.user._id, status: "pending" },
    { status: "accepted" },
    { new: true }
  ).populate(TICKET_POPULATE);
  if (!updated) throw new ApiError("لا يمكن قبول هذا الطلب", 400);

  await sendDepositMessage({
    ticketId: updated._id,
    senderId: req.user._id,
    system: true,
    body: "قبل الوكيل طلبك — سيرسل لك تفاصيل الدفع في المحادثة.",
  });
  await notifyAndPush(updated.user._id || updated.user, {
    title: "قبل الوكيل طلبك",
    subtitle: "تابع المحادثة لإتمام الدفع",
    sourceType: "deposit_accepted",
    sourceId: String(updated._id),
    data: { ticketId: String(updated._id) },
  });
  emitTicketUpdate(updated);
  res.status(200).json({ status: "success", data: serializeTicket(updated, "agent") });
});

exports.rejectTicket = asyncHandler(async (req, res) => {
  const reason = sanitizeBody(req.body?.reason || "").slice(0, 300);
  const updated = await DepositTicket.findOneAndUpdate(
    {
      _id: req.params.ticketId,
      agentUser: req.user._id,
      status: { $in: ["pending", "accepted", "waiting_payment", "receipt_uploaded"] },
    },
    {
      status: "rejected",
      closedAt: new Date(),
      closedBy: req.user._id,
      closeReason: reason,
    },
    { new: true }
  ).populate(TICKET_POPULATE);
  if (!updated) throw new ApiError("لا يمكن رفض هذا الطلب", 400);

  await sendDepositMessage({
    ticketId: updated._id,
    senderId: req.user._id,
    system: true,
    body: reason ? `تم رفض الطلب: ${reason}` : "تم رفض الطلب من قبل الوكيل.",
  });
  await notifyAndPush(updated.user._id || updated.user, {
    title: "تم رفض طلب الإيداع",
    subtitle: reason || "تواصل مع وكيل آخر أو حاول لاحقاً",
    sourceType: "deposit_rejected",
    sourceId: String(updated._id),
    data: { ticketId: String(updated._id) },
  });
  emitTicketUpdate(updated);
  res.status(200).json({ status: "success", data: serializeTicket(updated, "agent") });
});

async function approveVipTicket(req, res, candidate) {
  const { applyMembershipChange } = require("./vipService");
  const level = normalizeVipLevel(candidate.vipLevel);
  if (!level) throw new ApiError("باقة VIP غير صالحة", 400);

  const prev = await DepositTicket.findOneAndUpdate(
    {
      _id: candidate._id,
      agentUser: req.user._id,
      ticketType: "vip",
      status: { $in: APPROVABLE_STATUSES },
    },
    { status: "reviewing" },
    { new: false }
  );
  if (!prev) throw new ApiError("الطلب غير قابل للموافقة في حالته الحالية", 409);

  try {
    await applyMembershipChange({
      userId: prev.user,
      level,
      kind: "purchase",
      provider: "agent",
      providerRef: String(prev._id),
      actorId: req.user._id,
      note: `Agent approved VIP ticket ${prev._id}`,
      priceCents: Math.round((prev.priceUsd || 0) * 100),
    });
    await DepositTicket.updateOne(
      { _id: prev._id },
      {
        status: "completed",
        amountApproved: 0,
        approvedAt: new Date(),
        approvedBy: req.user._id,
      }
    );
  } catch (err) {
    await DepositTicket.updateOne(
      { _id: prev._id, status: "reviewing" },
      { status: prev.status }
    );
    throw err;
  }

  const levelLabel = vipLevelLabelAr(level);
  logEvent({
    event: "agent_vip_completed",
    actor: req.user._id,
    targetUser: prev.user,
    meta: {
      ticketId: String(prev._id),
      vipLevel: level,
      priceUsd: prev.priceUsd,
      country: prev.country,
      paymentMethod: prev.paymentMethod,
    },
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  await sendDepositMessage({
    ticketId: prev._id,
    senderId: req.user._id,
    system: true,
    body: `✅ تم تفعيل عضوية VIP ${levelLabel} بنجاح.`,
  });
  await notifyAndPush(prev.user, {
    title: "تم تفعيل VIP 🎉",
    subtitle: `عضوية VIP ${levelLabel} مفعّلة على حسابك`,
    sourceType: "vip_completed",
    sourceId: String(prev._id),
    data: { ticketId: String(prev._id), vipLevel: level },
  });

  const updated = await loadTicket(prev._id);
  emitTicketUpdate(updated, { vipLevel: level });
  if (depositIo) {
    depositIo.to(userRoom(prev.user)).emit("deposit:completed", {
      ticketId: String(prev._id),
      ticketType: "vip",
      vipLevel: level,
    });
  }

  res.status(200).json({ status: "success", data: serializeTicket(updated, "agent") });
}

/**
 * THE atomic transfer: agent wallet → user wallet (deposit tickets only).
 * VIP tickets activate membership instead of moving coins.
 */
exports.approveDeposit = asyncHandler(async (req, res) => {
  const candidate = await DepositTicket.findOne({
    _id: req.params.ticketId,
    agentUser: req.user._id,
    status: { $in: APPROVABLE_STATUSES },
  });
  if (!candidate) throw new ApiError("الطلب غير قابل للموافقة في حالته الحالية", 409);
  if (candidate.ticketType === "vip") {
    return approveVipTicket(req, res, candidate);
  }

  const amount = Math.round(Number(req.body?.amount));

  const prev = await DepositTicket.findOneAndUpdate(
    {
      _id: req.params.ticketId,
      agentUser: req.user._id,
      ticketType: { $ne: "vip" },
      status: { $in: APPROVABLE_STATUSES },
    },
    { status: "reviewing" },
    { new: false }
  );
  if (!prev) throw new ApiError("الطلب غير قابل للموافقة في حالته الحالية", 409);

  const finalAmount = Number.isFinite(amount) && amount >= 1 ? amount : prev.amountRequested;
  if (finalAmount > 1e12) {
    await DepositTicket.updateOne(
      { _id: prev._id, status: "reviewing" },
      { status: prev.status }
    );
    throw new ApiError("المبلغ غير صالح", 400);
  }

  try {
    await withMongoTransaction(async (session) => {
      await ledgerWithdraw({
        session,
        userId: req.user._id,
        amount: finalAmount,
        ledgerType: "agent_deposit_out",
        meta: { ticketId: String(prev._id), toUser: String(prev.user) },
      });
      await ledgerDeposit({
        session,
        userId: prev.user,
        amount: finalAmount,
        ledgerType: "agent_deposit_in",
        meta: { ticketId: String(prev._id), fromAgent: String(req.user._id) },
      });
      await DepositTicket.updateOne(
        { _id: prev._id },
        {
          status: "completed",
          amountApproved: finalAmount,
          approvedAt: new Date(),
          approvedBy: req.user._id,
        },
        { session }
      );
      await AgentProfile.updateOne(
        { _id: prev.agentProfile },
        {
          $inc: {
            "deposit.stats.totalDeposits": 1,
            "deposit.stats.totalVolume": finalAmount,
          },
        },
        { session }
      );
    });
  } catch (err) {
    // restore the pre-claim status so the agent can retry
    await DepositTicket.updateOne(
      { _id: prev._id, status: "reviewing" },
      { status: prev.status }
    );
    if (err?.message === "INSUFFICIENT_BALANCE" || err?.code === "INSUFFICIENT_BALANCE") {
      throw new ApiError("رصيد محفظتك غير كافٍ لإتمام الإيداع", 402);
    }
    throw err;
  }

  // --- post-commit side effects (never roll back money) ---
  logEvent({
    event: "agent_deposit_completed",
    actor: req.user._id,
    targetUser: prev.user,
    meta: {
      ticketId: String(prev._id),
      amount: finalAmount,
      country: prev.country,
      paymentMethod: prev.paymentMethod,
    },
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  await sendDepositMessage({
    ticketId: prev._id,
    senderId: req.user._id,
    system: true,
    body: `✅ تم إيداع ${finalAmount.toLocaleString("en-US")} في محفظتك بنجاح.`,
  });
  await notifyAndPush(prev.user, {
    title: "تم الإيداع بنجاح 🎉",
    subtitle: `أُضيف ${finalAmount.toLocaleString("en-US")} إلى محفظتك`,
    sourceType: "deposit_completed",
    sourceId: String(prev._id),
    data: { ticketId: String(prev._id), amount: finalAmount },
  });

  const updated = await loadTicket(prev._id);
  emitTicketUpdate(updated, { amountApproved: finalAmount });
  if (depositIo) {
    depositIo.to(userRoom(prev.user)).emit("deposit:completed", {
      ticketId: String(prev._id),
      amount: finalAmount,
    });
  }

  res.status(200).json({ status: "success", data: serializeTicket(updated, "agent") });
});

exports.getAgentWalletSummary = asyncHandler(async (req, res) => {
  const wallet = await getOrCreateWallet(req.user._id, null);

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const stats = await WalletTransaction.aggregate([
    {
      $match: {
        userId: req.user._id,
        type: "agent_deposit_out",
      },
    },
    {
      $facet: {
        daily: [
          { $match: { createdAt: { $gte: dayStart } } },
          { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: "$amount" } } },
        ],
        monthly: [
          { $match: { createdAt: { $gte: monthStart } } },
          { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: "$amount" } } },
        ],
        lifetime: [
          { $group: { _id: null, count: { $sum: 1 }, volume: { $sum: "$amount" } } },
        ],
      },
    },
  ]);

  const pick = (arr) => ({
    count: arr?.[0]?.count || 0,
    volume: arr?.[0]?.volume || 0,
  });
  const facet = stats?.[0] || {};

  res.status(200).json({
    status: "success",
    data: {
      balance: wallet.balance || 0,
      lockedBalance: wallet.lockedBalance || 0,
      daily: pick(facet.daily),
      monthly: pick(facet.monthly),
      lifetime: pick(facet.lifetime),
    },
  });
});

// ==============================================================================
// ADMIN endpoints
// ==============================================================================

exports.adminListAgents = asyncHandler(async (req, res) => {
  const rows = await AgentProfile.find({ "deposit.enabled": true })
    .populate("user", "name email profileImg")
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();
  res.status(200).json({
    status: "success",
    results: rows.length,
    data: rows.map((p) => ({
      agentProfileId: String(p._id),
      user: briefUser(p.user),
      email: p.user?.email || null,
      status: p.status,
      displayName: p.deposit?.displayName || "",
      countries: p.deposit?.countries || [],
      paymentMethods: p.deposit?.paymentMethods || [],
      workingHours: p.deposit?.workingHours || "",
      online: isAgentOnline(p.user?._id),
      stats: p.deposit?.stats || {},
    })),
  });
});

exports.adminCreateAgent = asyncHandler(async (req, res) => {
  const {
    userId,
    email,
    displayName = "",
    countries = [],
    paymentMethods = [],
    workingHours = "",
  } = req.body || {};

  const user = userId
    ? await User.findById(userId)
    : await User.findOne({ email: String(email || "").toLowerCase() });
  if (!user) throw new ApiError("المستخدم غير موجود", 404);

  const cleanCountries = countries
    .map((c) => String(c).toUpperCase())
    .filter((c) => findCountry(c));
  if (!cleanCountries.length) throw new ApiError("حدد دولة واحدة على الأقل", 400);

  let profile = await AgentProfile.findOne({ user: user._id });
  if (!profile) {
    profile = new AgentProfile({
      user: user._id,
      roleType: "agent",
      referralCode: AgentProfile.generateReferralCode(),
      createdBy: req.user._id,
    });
  }
  profile.status = "approved";
  profile.deposit = {
    ...(profile.deposit?.toObject?.() || profile.deposit || {}),
    enabled: true,
    displayName: sanitizeBody(displayName).slice(0, 80) || user.name || "وكيل",
    countries: cleanCountries,
    paymentMethods: paymentMethods.map((m) => sanitizeBody(m).slice(0, 60)).filter(Boolean),
    workingHours: sanitizeBody(workingHours).slice(0, 120),
  };
  await profile.save();

  logEvent({
    event: "agent_deposit_agent_upserted",
    actor: req.user._id,
    targetUser: user._id,
    meta: { agentProfileId: String(profile._id), countries: cleanCountries },
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({
    status: "success",
    data: { agentProfileId: String(profile._id), userId: String(user._id) },
  });
});

exports.adminSetAgentStatus = asyncHandler(async (req, res) => {
  const { enabled, suspend } = req.body || {};
  const profile = await AgentProfile.findById(req.params.agentProfileId);
  if (!profile) throw new ApiError("الوكيل غير موجود", 404);

  if (typeof enabled === "boolean") profile.deposit.enabled = enabled;
  if (typeof suspend === "boolean") profile.status = suspend ? "suspended" : "approved";
  await profile.save();

  logEvent({
    event: "agent_deposit_agent_status",
    actor: req.user._id,
    targetUser: profile.user,
    meta: { enabled: profile.deposit.enabled, status: profile.status },
    ip: req.ip,
  });
  res.status(200).json({ status: "success" });
});

exports.adminAssignCountries = asyncHandler(async (req, res) => {
  const countries = (req.body?.countries || [])
    .map((c) => String(c).toUpperCase())
    .filter((c) => findCountry(c));
  if (!countries.length) throw new ApiError("حدد دولة واحدة على الأقل", 400);

  const profile = await AgentProfile.findByIdAndUpdate(
    req.params.agentProfileId,
    { "deposit.countries": countries },
    { new: true }
  );
  if (!profile) throw new ApiError("الوكيل غير موجود", 404);
  res.status(200).json({ status: "success", data: { countries } });
});

async function adminAdjustAgentWallet(req, res, direction) {
  const amount = Math.round(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount < 1) throw new ApiError("المبلغ غير صالح", 400);

  const profile = await AgentProfile.findById(req.params.agentProfileId);
  if (!profile) throw new ApiError("الوكيل غير موجود", 404);

  try {
    await withMongoTransaction(async (session) => {
      if (direction === "credit") {
        await ledgerDeposit({
          session,
          userId: profile.user,
          amount,
          ledgerType: "admin_agent_credit",
          meta: { by: String(req.user._id) },
        });
      } else {
        await ledgerWithdraw({
          session,
          userId: profile.user,
          amount,
          ledgerType: "admin_agent_debit",
          meta: { by: String(req.user._id) },
        });
      }
    });
  } catch (err) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("رصيد الوكيل غير كافٍ", 402);
    }
    throw err;
  }

  logEvent({
    event: direction === "credit" ? "agent_wallet_recharged" : "agent_wallet_withdrawn",
    actor: req.user._id,
    targetUser: profile.user,
    meta: { amount },
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  const wallet = await getOrCreateWallet(profile.user, null);
  res.status(200).json({
    status: "success",
    data: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
  });
}

exports.adminRechargeAgentWallet = asyncHandler((req, res) =>
  adminAdjustAgentWallet(req, res, "credit")
);

exports.adminWithdrawAgentBalance = asyncHandler((req, res) =>
  adminAdjustAgentWallet(req, res, "debit")
);

exports.adminGetAgentWallet = asyncHandler(async (req, res) => {
  const profile = await AgentProfile.findById(req.params.agentProfileId).populate(
    "user",
    "name email"
  );
  if (!profile) throw new ApiError("الوكيل غير موجود", 404);

  const wallet = await getOrCreateWallet(profile.user._id, null);
  const transactions = await WalletTransaction.find({
    userId: profile.user._id,
    type: {
      $in: ["agent_deposit_out", "agent_deposit_in", "admin_agent_credit", "admin_agent_debit"],
    },
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  res.status(200).json({
    status: "success",
    data: {
      user: briefUser(profile.user),
      balance: wallet.balance,
      lockedBalance: wallet.lockedBalance,
      stats: profile.deposit?.stats || {},
      transactions: transactions.map((t) => ({
        id: String(t._id),
        type: t.type,
        amount: t.amount,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        meta: t.meta || {},
        createdAt: t.createdAt,
      })),
    },
  });
});

exports.adminListTickets = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = req.query.status;
  if (req.query.country) q.country = String(req.query.country).toUpperCase();
  if (req.query.agentProfileId) q.agentProfile = req.query.agentProfileId;
  if (req.query.ticketType) q.ticketType = String(req.query.ticketType).toLowerCase();

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const [rows, total] = await Promise.all([
    DepositTicket.find(q)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate(TICKET_POPULATE)
      .lean(),
    DepositTicket.countDocuments(q),
  ]);
  res.status(200).json({
    status: "success",
    results: rows.length,
    total,
    page,
    data: rows.map((t) => serializeTicket(t, "agent")),
  });
});

exports.adminForceCloseTicket = asyncHandler(async (req, res) => {
  const updated = await DepositTicket.findOneAndUpdate(
    { _id: req.params.ticketId, status: { $in: ACTIVE_STATUSES } },
    {
      status: "cancelled",
      closedAt: new Date(),
      closedBy: req.user._id,
      closeReason: sanitizeBody(req.body?.reason || "أُغلق الطلب من الإدارة").slice(0, 300),
    },
    { new: true }
  ).populate(TICKET_POPULATE);
  if (!updated) throw new ApiError("الطلب غير قابل للإغلاق", 400);

  await sendDepositMessage({
    ticketId: updated._id,
    senderId: req.user._id,
    system: true,
    body: "تم إغلاق هذا الطلب من قبل الإدارة.",
  });
  emitTicketUpdate(updated);
  logEvent({
    event: "agent_deposit_force_closed",
    actor: req.user._id,
    targetUser: updated.user._id || updated.user,
    meta: { ticketId: String(updated._id) },
    ip: req.ip,
  });
  res.status(200).json({ status: "success" });
});

exports.adminTransferTicket = asyncHandler(async (req, res) => {
  const target = await AgentProfile.findOne({
    _id: req.body?.agentProfileId,
    status: "approved",
    "deposit.enabled": true,
  }).populate("user", "name profileImg");
  if (!target) throw new ApiError("الوكيل الهدف غير متاح", 404);

  const updated = await DepositTicket.findOneAndUpdate(
    { _id: req.params.ticketId, status: { $in: ACTIVE_STATUSES } },
    { agentProfile: target._id, agentUser: target.user._id, status: "pending" },
    { new: true }
  ).populate(TICKET_POPULATE);
  if (!updated) throw new ApiError("الطلب غير قابل للتحويل", 400);

  await sendDepositMessage({
    ticketId: updated._id,
    senderId: req.user._id,
    system: true,
    body: `تم تحويل الطلب إلى الوكيل ${target.deposit?.displayName || target.user.name}.`,
  });
  await notifyAndPush(target.user._id, {
    title: "تم تحويل طلب إيداع إليك",
    subtitle: "راجع الطلبات الجديدة في غرفة الوكيل",
    sourceType: "deposit_transferred",
    sourceId: String(updated._id),
    data: { ticketId: String(updated._id) },
  });
  emitTicketUpdate(updated);
  res.status(200).json({ status: "success", data: serializeTicket(updated, "agent") });
});

exports.adminStatistics = asyncHandler(async (req, res) => {
  const [byStatus, volume, agents, vipCompleted] = await Promise.all([
    DepositTicket.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    DepositTicket.aggregate([
      { $match: { status: "completed", ticketType: { $ne: "vip" } } },
      { $group: { _id: null, total: { $sum: "$amountApproved" }, count: { $sum: 1 } } },
    ]),
    AgentProfile.countDocuments({ "deposit.enabled": true, status: "approved" }),
    DepositTicket.countDocuments({ ticketType: "vip", status: "completed" }),
  ]);
  res.status(200).json({
    status: "success",
    data: {
      tickets: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
      completedVolume: volume?.[0]?.total || 0,
      completedCount: volume?.[0]?.count || 0,
      vipCompletedCount: vipCompleted,
      activeAgents: agents,
    },
  });
});

// --- exports for the socket namespace ----------------------------------------

exports.setDepositIo = setDepositIo;
exports.ticketRoom = ticketRoom;
exports.userRoom = userRoom;
exports.markAgentOnline = markAgentOnline;
exports.markAgentOffline = markAgentOffline;
exports.isAgentOnline = isAgentOnline;
exports.isStaffRole = isStaffRole;
exports.getDepositProfile = getDepositProfile;
exports.assertTicketAccess = assertTicketAccess;
exports.sendDepositMessage = sendDepositMessage;
exports.getTicketMessagesForViewer = getTicketMessages;
exports.markTicketReadForViewer = markTicketRead;
exports.serializeTicket = serializeTicket;
exports.loadTicket = loadTicket;
exports.viewerFor = viewerFor;
