"use strict";

/**
 * Platform staff + admin bootstrap APIs.
 * Superadmin creates admins/managers/support and assigns permissions.
 */
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const User = require("../models/userModel");
const AgentProfile = require("../models/agentProfileModel");
const DepositTicket = require("../models/depositTicketModel");
const SupportTicket = require("../models/supportTicketModel");
const Table = require("../models/tableModel");
const { logEvent } = require("./auditService");
const {
  CAPABILITIES,
  STAFF_ROLES,
  ROLE_DEFAULTS,
  isStaffRole,
  isSuperAdmin,
  capabilitiesFor,
  permissionsCatalog,
  sanitizePermissions,
  requirePermission,
} = require("./platformPermissions");

const STAFF_SELECT =
  "name email role permissions active country profileImg createdAt updatedAt sessionVersion";

function serializeStaff(user) {
  if (!user) return null;
  const row = user.toObject ? user.toObject() : user;
  return {
    id: String(row._id),
    name: row.name,
    email: row.email,
    role: row.role,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    effectivePermissions: capabilitiesFor(row),
    active: row.active !== false,
    country: row.country || null,
    profileImg: row.profileImg || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertCanManageStaff(actor) {
  if (!isSuperAdmin(actor) && !capabilitiesFor(actor).includes(CAPABILITIES.STAFF_WRITE)) {
    throw new ApiError("فقط السوبر أدمن يدير طاقم الإدارة والصلاحيات", 403);
  }
}

function normalizeStaffRole(role) {
  const r = String(role || "").toLowerCase().trim();
  if (!STAFF_ROLES.includes(r)) {
    throw new ApiError("دور غير صالح للطاقم", 400);
  }
  return r;
}

/** GET /admin/me — bootstrap for Admin Dashboard */
exports.adminMe = asyncHandler(async (req, res) => {
  if (!isStaffRole(req.user.role)) {
    throw new ApiError("ليس لديك صلاحية دخول لوحة الإدارة", 403);
  }
  const caps = capabilitiesFor(req.user);
  res.status(200).json({
    status: "success",
    data: {
      user: {
        id: String(req.user._id),
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        profileImg: req.user.profileImg || null,
      },
      permissions: caps,
      isSuperAdmin: isSuperAdmin(req.user),
      modules: {
        staff: caps.includes(CAPABILITIES.STAFF_READ) || isSuperAdmin(req.user),
        users: caps.includes(CAPABILITIES.USERS_READ),
        support: caps.includes(CAPABILITIES.SUPPORT_READ),
        agents: caps.includes(CAPABILITIES.AGENTS_READ),
        vip: caps.includes(CAPABILITIES.VIP),
        economy: caps.includes(CAPABILITIES.ECONOMY),
        cosmetics: caps.includes(CAPABILITIES.COSMETICS),
        tables: caps.includes(CAPABILITIES.TABLES),
        bots: caps.includes(CAPABILITIES.BOTS),
        clans: caps.includes(CAPABILITIES.CLANS),
        referrals: caps.includes(CAPABILITIES.REFERRALS),
        recharge: caps.includes(CAPABILITIES.RECHARGE),
        games: caps.includes(CAPABILITIES.GAMES),
        settings: caps.includes(CAPABILITIES.SETTINGS),
        audit: caps.includes(CAPABILITIES.AUDIT),
        reports: caps.includes(CAPABILITIES.REPORTS),
      },
    },
  });
});

/** GET /admin/permissions-catalog */
exports.adminPermissionsCatalog = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  res.status(200).json({ status: "success", data: permissionsCatalog() });
});

/** GET /admin/staff */
exports.adminListStaff = asyncHandler(async (req, res) => {
  if (
    !isSuperAdmin(req.user) &&
    !capabilitiesFor(req.user).includes(CAPABILITIES.STAFF_READ)
  ) {
    throw new ApiError("لا صلاحية لعرض الطاقم", 403);
  }
  const filter = { role: { $in: STAFF_ROLES } };
  if (req.query.role && STAFF_ROLES.includes(String(req.query.role))) {
    filter.role = String(req.query.role);
  }
  if (req.query.active === "true") filter.active = true;
  if (req.query.active === "false") filter.active = false;

  const rows = await User.find(filter)
    .select(STAFF_SELECT)
    .sort({ role: 1, createdAt: -1 })
    .limit(Math.min(parseInt(req.query.limit || "200", 10), 500))
    .lean();

  res.status(200).json({
    status: "success",
    results: rows.length,
    data: rows.map(serializeStaff),
  });
});

/** POST /admin/staff — create staff account */
exports.adminCreateStaff = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  const {
    name,
    email,
    password,
    role: rawRole,
    permissions,
    country,
  } = req.body || {};

  if (!name || !email || !password) {
    throw new ApiError("الاسم والبريد وكلمة المرور مطلوبة", 400);
  }
  if (String(password).length < 6) {
    throw new ApiError("كلمة المرور قصيرة جداً", 400);
  }

  const role = normalizeStaffRole(rawRole || "support");
  if (role === "superadmin" && !isSuperAdmin(req.user)) {
    throw new ApiError("لا يمكن إنشاء سوبر أدمن إلا من سوبر أدمن", 403);
  }

  const exists = await User.findOne({ email: String(email).toLowerCase() });
  if (exists) throw new ApiError("البريد مستخدم مسبقاً", 409);

  let perms = sanitizePermissions(permissions);
  if (!perms.length) perms = (ROLE_DEFAULTS[role] || []).slice();

  const user = await User.create({
    name: String(name).trim(),
    email: String(email).toLowerCase().trim(),
    password: String(password),
    role,
    permissions: role === "superadmin" ? [] : perms,
    country: country ? String(country).toUpperCase() : undefined,
    active: true,
  });

  logEvent({
    event: "staff_created",
    actor: req.user._id,
    targetUser: user._id,
    meta: { role, permissions: user.permissions || [] },
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.status(201).json({ status: "success", data: serializeStaff(user) });
});

/** GET /admin/staff/:id */
exports.adminGetStaff = asyncHandler(async (req, res) => {
  if (
    !isSuperAdmin(req.user) &&
    !capabilitiesFor(req.user).includes(CAPABILITIES.STAFF_READ)
  ) {
    throw new ApiError("لا صلاحية لعرض الطاقم", 403);
  }
  const user = await User.findById(req.params.id).select(STAFF_SELECT);
  if (!user || !isStaffRole(user.role)) {
    throw new ApiError("عضو الطاقم غير موجود", 404);
  }
  res.status(200).json({ status: "success", data: serializeStaff(user) });
});

/** PUT /admin/staff/:id — update role / permissions / active / name */
exports.adminUpdateStaff = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError("المستخدم غير موجود", 404);

  if (String(user._id) === String(req.user._id) && req.body?.active === false) {
    throw new ApiError("لا يمكن تعطيل حسابك بنفسك", 400);
  }

  const prevRole = user.role;
  if (user.role === "superadmin" && !isSuperAdmin(req.user)) {
    throw new ApiError("لا يمكن تعديل سوبر أدمن", 403);
  }

  if (req.body?.name) user.name = String(req.body.name).trim();
  if (req.body?.country != null) {
    user.country = String(req.body.country || "").toUpperCase() || undefined;
  }
  if (typeof req.body?.active === "boolean") user.active = req.body.active;

  if (req.body?.role != null) {
    const role = normalizeStaffRole(req.body.role);
    if (role === "superadmin" && !isSuperAdmin(req.user)) {
      throw new ApiError("لا يمكن ترقية مستخدم لسوبر أدمن إلا من سوبر أدمن", 403);
    }
    // Demote staff to player
    if (req.body.role === "user") {
      user.role = "user";
      user.permissions = [];
    } else {
      user.role = role;
    }
  }

  if (Array.isArray(req.body?.permissions)) {
    if (user.role === "superadmin") {
      user.permissions = [];
    } else if (isStaffRole(user.role)) {
      user.permissions = sanitizePermissions(req.body.permissions);
    }
  }

  // Invalidate sessions when role/permissions/active change.
  if (
    prevRole !== user.role ||
    typeof req.body?.active === "boolean" ||
    Array.isArray(req.body?.permissions)
  ) {
    user.sessionVersion = (user.sessionVersion || 0) + 1;
  }

  await user.save();

  logEvent({
    event: "staff_updated",
    actor: req.user._id,
    targetUser: user._id,
    meta: {
      role: user.role,
      permissions: user.permissions || [],
      active: user.active,
    },
    ip: req.ip,
  });

  res.status(200).json({ status: "success", data: serializeStaff(user) });
});

/** PATCH /admin/staff/:id/permissions */
exports.adminSetStaffPermissions = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  const user = await User.findById(req.params.id);
  if (!user || !isStaffRole(user.role)) {
    throw new ApiError("عضو الطاقم غير موجود", 404);
  }
  if (user.role === "superadmin") {
    throw new ApiError("السوبر أدمن يملك كل الصلاحيات تلقائياً", 400);
  }
  user.permissions = sanitizePermissions(req.body?.permissions || []);
  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();

  logEvent({
    event: "staff_permissions_set",
    actor: req.user._id,
    targetUser: user._id,
    meta: { permissions: user.permissions },
    ip: req.ip,
  });

  res.status(200).json({ status: "success", data: serializeStaff(user) });
});

/** POST /admin/staff/:id/reset-password */
exports.adminResetStaffPassword = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  const password = String(req.body?.password || "");
  if (password.length < 6) throw new ApiError("كلمة المرور قصيرة جداً", 400);

  const user = await User.findById(req.params.id);
  if (!user || !isStaffRole(user.role)) {
    throw new ApiError("عضو الطاقم غير موجود", 404);
  }
  if (user.role === "superadmin" && !isSuperAdmin(req.user)) {
    throw new ApiError("ممنوع", 403);
  }
  user.password = password;
  user.passwordChangedAt = Date.now();
  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();

  logEvent({
    event: "staff_password_reset",
    actor: req.user._id,
    targetUser: user._id,
    ip: req.ip,
  });
  res.status(200).json({ status: "success" });
});

/**
 * Promote an existing player to staff (or change staff role).
 * POST /admin/staff/promote { userId, role, permissions }
 */
exports.adminPromoteUser = asyncHandler(async (req, res) => {
  assertCanManageStaff(req.user);
  const userId = req.body?.userId;
  if (!userId) throw new ApiError("userId مطلوب", 400);

  const user = await User.findById(userId);
  if (!user) throw new ApiError("المستخدم غير موجود", 404);

  const role = normalizeStaffRole(req.body?.role || "support");
  if (role === "superadmin" && !isSuperAdmin(req.user)) {
    throw new ApiError("لا يمكن ترقية لسوبر أدمن إلا من سوبر أدمن", 403);
  }

  let perms = sanitizePermissions(req.body?.permissions);
  if (!perms.length) perms = (ROLE_DEFAULTS[role] || []).slice();

  user.role = role;
  user.permissions = role === "superadmin" ? [] : perms;
  user.sessionVersion = (user.sessionVersion || 0) + 1;
  await user.save();

  logEvent({
    event: "staff_promoted",
    actor: req.user._id,
    targetUser: user._id,
    meta: { role, permissions: user.permissions },
    ip: req.ip,
  });

  res.status(200).json({ status: "success", data: serializeStaff(user) });
});

/** Statuses that mean a table is currently in use / available to play. */
const LIVE_TABLE_STATUSES = new Set(["waiting", "ready", "playing", "full", "open"]);

/** GET /admin/platform/overview — counts for owner dashboard home */
exports.adminPlatformOverview = asyncHandler(async (req, res) => {
  if (!isStaffRole(req.user.role)) {
    throw new ApiError("ليس لديك صلاحية", 403);
  }

  const [
    usersTotal,
    usersActive,
    staffCount,
    agentsCount,
    openSupport,
    openDepositTickets,
    vipSales,
    coinSales,
    tables,
  ] = await Promise.all([
    User.countDocuments({ role: "user" }),
    User.countDocuments({ role: "user", active: true }),
    User.countDocuments({ role: { $in: STAFF_ROLES } }),
    AgentProfile.countDocuments({ "deposit.enabled": true, status: "approved" }),
    SupportTicket.countDocuments({ status: { $in: ["open", "pending"] } }),
    DepositTicket.countDocuments({
      status: { $in: ["pending", "accepted", "waiting_payment", "receipt_uploaded", "reviewing"] },
    }),
    DepositTicket.countDocuments({ ticketType: "vip", status: "completed" }),
    DepositTicket.countDocuments({ ticketType: { $ne: "vip" }, status: "completed" }),
    Table.find(
      {},
      { status: 1, gameType: 1, seats: 1, tableKind: 1, tableNumber: 1 }
    )
      .limit(500)
      .lean(),
  ]);

  const byStatus = {};
  const byGameType = {};
  let seatedPlayers = 0;
  let liveTables = 0;
  let playingTables = 0;
  const uniqueSeated = new Set();

  for (const t of tables) {
    const st = t.status || "unknown";
    byStatus[st] = (byStatus[st] || 0) + 1;
    const gt = t.gameType || "unknown";
    byGameType[gt] = (byGameType[gt] || 0) + 1;

    const seats = Array.isArray(t.seats) ? t.seats : [];
    seatedPlayers += seats.length;
    for (const s of seats) {
      if (s?.user) uniqueSeated.add(String(s.user));
    }
    if (LIVE_TABLE_STATUSES.has(st) || seats.length > 0) liveTables += 1;
    if (st === "playing") playingTables += 1;
  }

  res.status(200).json({
    status: "success",
    data: {
      users: { total: usersTotal, active: usersActive },
      staff: { total: staffCount },
      agents: { activeDepositAgents: agentsCount },
      support: { openTickets: openSupport },
      deposits: {
        openTickets: openDepositTickets,
        completedCoinSales: coinSales,
        completedVipSales: vipSales,
      },
      /** Live ops snapshot from Mongo table seats (not presence sockets). */
      live: {
        totalTables: tables.length,
        liveTables,
        playingTables,
        seatedPlayers,
        uniqueSeatedPlayers: uniqueSeated.size,
        byStatus,
        byGameType,
      },
    },
  });
});

module.exports.requirePermission = requirePermission;
module.exports.CAPABILITIES = CAPABILITIES;
module.exports.serializeStaff = serializeStaff;
