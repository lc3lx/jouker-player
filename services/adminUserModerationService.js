"use strict";

/**
 * Admin player-management endpoints backing the profile popup's admin section
 * (View Full Account / Transactions / Purchases / VIP History / Reports +
 * Suspend/Ban/Mute). Admin/manager only (enforced at the route). Every
 * moderation action is audited and busts the profile snapshot cache.
 */

const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const mongoose = require("mongoose");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const VIPHistory = require("../models/vipHistoryModel");
const PlayerReport = require("../models/playerReportModel");
const AgentProfile = require("../models/agentProfileModel");
const auditService = require("./auditService");
const playerProfileService = require("./playerProfileService");
const { findCountry } = require("../data/countries");
const {
  CAPABILITIES,
  STAFF_ROLES,
  ROLE_DEFAULTS,
  isStaffRole,
  isSuperAdmin,
  capabilitiesFor,
  sanitizePermissions,
} = require("./platformPermissions");

const PURCHASE_TYPES = ["cosmetic_purchase", "interaction_purchase", "interaction_use"];

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; }
}

function paging(req) {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
  return { page, limit, skip: (page - 1) * limit };
}

async function _requireUser(id) {
  const user = await User.findById(id).lean();
  if (!user) throw new ApiError("User not found", 404);
  return user;
}

exports.adminUserOverview = asyncHandler(async (req, res) => {
  const user = await _requireUser(req.params.id);
  const wallet = await Wallet.findOne({ user: user._id }).lean();
  res.status(200).json({
    status: "success",
    data: {
      id: String(user._id),
      playerId: typeof user.playerId === "number" ? user.playerId : null,
      nameChangeCount: user.nameChangeCount || 0,
      name: user.name,
      email: user.email,
      country: user.country || null,
      role: user.role,
      memberSince: user.createdAt,
      profileImg: user.profileImg || null,
      wallet: { balance: wallet?.balance || 0, lockedBalance: wallet?.lockedBalance || 0 },
      flags: {
        active: user.active !== false,
        muted: !!user.muted,
        mutedReason: user.mutedReason || null,
        trustRestricted: !!user.trustRestricted,
        suspiciousFlag: !!user.suspiciousFlag,
        vip: !!user.vip?.active,
      },
    },
  });
});

exports.adminUserTransactions = asyncHandler(async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) throw new ApiError("Invalid user id", 400);
  const { page, limit, skip } = paging(req);
  const filter = { userId: oid };
  if (req.query.type) filter.type = String(req.query.type);
  const [total, rows] = await Promise.all([
    WalletTransaction.countDocuments(filter),
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.status(200).json({ status: "success", data: { page, limit, total, rows } });
});

exports.adminUserPurchases = asyncHandler(async (req, res) => {
  const oid = toObjectId(req.params.id);
  if (!oid) throw new ApiError("Invalid user id", 400);
  const { page, limit, skip } = paging(req);
  const filter = { userId: oid, type: { $in: PURCHASE_TYPES } };
  const [total, rows] = await Promise.all([
    WalletTransaction.countDocuments(filter),
    WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.status(200).json({ status: "success", data: { page, limit, total, rows } });
});

exports.adminUserVipHistory = asyncHandler(async (req, res) => {
  await _requireUser(req.params.id);
  const { limit } = paging(req);
  const rows = await VIPHistory.find({ userId: req.params.id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.status(200).json({ status: "success", data: { rows } });
});

exports.adminUserReports = asyncHandler(async (req, res) => {
  await _requireUser(req.params.id);
  const { page, limit, skip } = paging(req);
  const filter = { reported: req.params.id };
  const [total, rows] = await Promise.all([
    PlayerReport.countDocuments(filter),
    PlayerReport.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("reporter", "name")
      .lean(),
  ]);
  res.status(200).json({ status: "success", data: { page, limit, total, rows } });
});

// ── moderation actions ───────────────────────────────────────────────────────

async function _moderate(req, res, { set, event }) {
  const user = await User.findById(req.params.id).select("_id active muted sessionVersion");
  if (!user) throw new ApiError("User not found", 404);
  Object.assign(user, set);
  if (set.active === false) {
    user.sessionVersion = Math.floor(Number(user.sessionVersion) || 0) + 1;
  }
  await user.save();
  playerProfileService.invalidate(user._id);
  await auditService.logEvent({
    event,
    actor: req.user._id,
    targetUser: user._id,
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null,
    meta: { reason: req.body?.reason || null },
  });
  res.status(200).json({ status: "success", data: { id: String(user._id), ...set } });
}

exports.adminBanUser = asyncHandler((req, res) =>
  _moderate(req, res, { set: { active: false }, event: "admin_user_banned" })
);
exports.adminUnbanUser = asyncHandler((req, res) =>
  _moderate(req, res, { set: { active: true }, event: "admin_user_unbanned" })
);
exports.adminMuteUser = asyncHandler((req, res) =>
  _moderate(req, res, { set: { muted: true, mutedReason: req.body?.reason || null }, event: "admin_user_muted" })
);
exports.adminUnmuteUser = asyncHandler((req, res) =>
  _moderate(req, res, { set: { muted: false, mutedReason: null }, event: "admin_user_unmuted" })
);

// ── wallet credit / debit (coins) ────────────────────────────────────────────

const {
  withMongoTransaction,
  ledgerDeposit,
  ledgerWithdraw,
  getOrCreateWallet,
} = require("./walletLedgerService");

const ASSIGNABLE_ROLES = ["user", "support", "manager", "admin"];

function serializeListedUser(u, wallet, agent) {
  return {
    id: String(u._id),
    playerId: typeof u.playerId === "number" ? u.playerId : null,
    name: u.name,
    email: u.email,
    role: u.role || "user",
    active: u.active !== false,
    country: u.country || null,
    profileImg: u.profileImg || null,
    createdAt: u.createdAt,
    wallet: {
      balance: wallet?.balance || 0,
      lockedBalance: wallet?.lockedBalance || 0,
    },
    isAgent: !!(agent && agent.status === "approved" && agent.deposit?.enabled),
    agentStatus: agent?.status || null,
    agentProfileId: agent ? String(agent._id) : null,
    agentCountries: agent?.deposit?.countries || [],
  };
}

async function attachWalletsAndAgents(users) {
  const ids = users.map((u) => u._id);
  const [wallets, agents] = await Promise.all([
    Wallet.find({ user: { $in: ids } }).select("user balance lockedBalance").lean(),
    AgentProfile.find({ user: { $in: ids } })
      .select("user status deposit.enabled deposit.countries")
      .lean(),
  ]);
  const walletByUser = new Map(wallets.map((w) => [String(w.user), w]));
  const agentByUser = new Map(agents.map((a) => [String(a.user), a]));
  return users.map((u) =>
    serializeListedUser(u, walletByUser.get(String(u._id)), agentByUser.get(String(u._id)))
  );
}

async function upsertDepositAgent(user, { countries, displayName, actorId }) {
  let cleanCountries = (countries || [])
    .map((c) => String(c).toUpperCase())
    .filter((c) => findCountry(c));
  if (!cleanCountries.length && user.country && findCountry(user.country)) {
    cleanCountries = [String(user.country).toUpperCase()];
  }
  if (!cleanCountries.length) cleanCountries = ["SA"];

  let profile = await AgentProfile.findOne({ user: user._id });
  if (!profile) {
    profile = new AgentProfile({
      user: user._id,
      roleType: "agent",
      referralCode: AgentProfile.generateReferralCode(),
      createdBy: actorId,
    });
  }
  profile.status = "approved";
  const prev = profile.deposit?.toObject?.() || profile.deposit || {};
  profile.deposit = {
    ...prev,
    enabled: true,
    displayName:
      String(displayName || prev.displayName || user.name || "وكيل").slice(0, 80),
    countries: cleanCountries,
    paymentMethods: prev.paymentMethods || [],
    workingHours: prev.workingHours || "",
  };
  await profile.save();
  return profile;
}

function assertCanAssignStaff(actor) {
  if (isSuperAdmin(actor)) return;
  if (capabilitiesFor(actor).includes(CAPABILITIES.STAFF_WRITE)) return;
  throw new ApiError("فقط السوبر أدمن أو من يملك إدارة الطاقم يعيّن أدمن/مدير", 403);
}

function assertCanManageAgents(actor) {
  if (isSuperAdmin(actor)) return;
  const caps = capabilitiesFor(actor);
  if (caps.includes(CAPABILITIES.AGENTS_WRITE) || caps.includes(CAPABILITIES.STAFF_WRITE)) {
    return;
  }
  throw new ApiError("لا صلاحية لتعيين وكيل", 403);
}

/** GET /admin/users — paginated directory for the dashboard */
exports.adminListUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = paging(req);
  const q = String(req.query.q || "").trim();
  const role = String(req.query.role || "").toLowerCase();
  const filter = { isBot: { $ne: true } };

  if (!isSuperAdmin(req.user)) {
    filter.role = { $nin: ["superadmin"] };
  }
  if (role === "agent") {
    const agentUsers = await AgentProfile.find({
      status: "approved",
      "deposit.enabled": true,
    })
      .select("user")
      .lean();
    filter._id = { $in: agentUsers.map((a) => a.user) };
  } else if (role && (role === "user" || STAFF_ROLES.includes(role))) {
    filter.role = isSuperAdmin(req.user)
      ? role
      : role === "superadmin"
        ? { $in: [] }
        : role;
  }

  if (q) {
    const asNumber = /^\d{1,9}$/.test(q) ? Number(q) : null;
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const or = [{ email: rx }, { name: rx }];
    if (asNumber !== null) or.unshift({ playerId: asNumber });
    filter.$or = or;
  }

  const [total, rows] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .select("name email profileImg role active country createdAt playerId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  res.status(200).json({
    status: "success",
    results: rows.length,
    data: {
      page,
      limit,
      total,
      rows: await attachWalletsAndAgents(rows),
    },
  });
});

/**
 * PATCH /admin/users/:id/access
 * Body: { role?, makeAgent?, revokeAgent?, countries?, displayName? }
 * role: user | support | manager | admin
 * makeAgent: create/approve deposit-agent profile (does not change user.role)
 */
exports.adminSetUserAccess = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError("المستخدم غير موجود", 404);
  if (user.isBot) throw new ApiError("لا يمكن تعديل حساب بوت", 400);

  if (user.role === "superadmin" && !isSuperAdmin(req.user)) {
    throw new ApiError("لا يمكن تعديل سوبر أدمن", 403);
  }
  if (String(user._id) === String(req.user._id) && req.body?.role === "user") {
    throw new ApiError("لا يمكن تخفيض دور حسابك بنفسك", 400);
  }

  const rawRole = req.body?.role != null ? String(req.body.role).toLowerCase().trim() : null;
  const makeAgent = req.body?.makeAgent === true || rawRole === "agent";
  const revokeAgent = req.body?.revokeAgent === true;
  let roleChanged = false;

  if (rawRole && rawRole !== "agent") {
    if (rawRole === "superadmin") {
      if (!isSuperAdmin(req.user)) {
        throw new ApiError("لا يمكن ترقية مستخدم لسوبر أدمن إلا من سوبر أدمن", 403);
      }
    } else if (!ASSIGNABLE_ROLES.includes(rawRole)) {
      throw new ApiError("دور غير صالح", 400);
    }

    if (rawRole !== "user") assertCanAssignStaff(req.user);
    else if (isStaffRole(user.role)) assertCanAssignStaff(req.user);

    if (user.role !== rawRole) {
      user.role = rawRole;
      if (rawRole === "superadmin") {
        user.permissions = [];
      } else if (isStaffRole(rawRole)) {
        const perms = sanitizePermissions(req.body?.permissions);
        user.permissions = perms.length ? perms : (ROLE_DEFAULTS[rawRole] || []).slice();
      } else {
        user.permissions = [];
      }
      user.sessionVersion = (user.sessionVersion || 0) + 1;
      roleChanged = true;
    }
  }

  if (makeAgent) assertCanManageAgents(req.user);
  if (revokeAgent) assertCanManageAgents(req.user);

  let agent = null;
  if (makeAgent) {
    agent = await upsertDepositAgent(user, {
      countries: req.body?.countries,
      displayName: req.body?.displayName,
      actorId: req.user._id,
    });
  } else if (revokeAgent) {
    agent = await AgentProfile.findOne({ user: user._id });
    if (agent) {
      agent.status = "suspended";
      if (agent.deposit) agent.deposit.enabled = false;
      await agent.save();
    }
  } else {
    agent = await AgentProfile.findOne({ user: user._id });
  }

  if (roleChanged) await user.save();

  await auditService.logEvent({
    event: "admin_user_access",
    actor: req.user._id,
    targetUser: user._id,
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null,
    meta: {
      role: user.role,
      makeAgent,
      revokeAgent,
      agentProfileId: agent ? String(agent._id) : null,
    },
  });

  const wallet = await Wallet.findOne({ user: user._id })
    .select("balance lockedBalance")
    .lean();
  const leanUser = user.toObject();
  leanUser._id = user._id;
  res.status(200).json({
    status: "success",
    data: serializeListedUser(leanUser, wallet, agent),
  });
});

/** GET /admin/users/search?q= */
exports.adminSearchUsers = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "").trim();
  // A bare player number is a complete search term, so the two-character floor
  // only applies to text.
  const asNumber = /^\d{1,9}$/.test(q) ? Number(q) : null;
  if (asNumber === null && q.length < 2) {
    throw new ApiError("اكتب حرفين على الأقل للبحث", 400);
  }
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const or = [{ email: rx }, { name: rx }];
  if (asNumber !== null) or.unshift({ playerId: asNumber });
  const users = await User.find({
    $or: or,
    role: { $nin: ["superadmin"] },
  })
    .select("name email profileImg role active country createdAt playerId")
    .limit(limit)
    .lean();

  const ids = users.map((u) => u._id);
  const wallets = await Wallet.find({ user: { $in: ids } })
    .select("user balance lockedBalance")
    .lean();
  const byUser = new Map(wallets.map((w) => [String(w.user), w]));

  res.status(200).json({
    status: "success",
    results: users.length,
    data: users.map((u) => {
      const w = byUser.get(String(u._id));
      return {
        id: String(u._id),
        playerId: typeof u.playerId === "number" ? u.playerId : null,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active !== false,
        country: u.country || null,
        profileImg: u.profileImg || null,
        wallet: {
          balance: w?.balance || 0,
          lockedBalance: w?.lockedBalance || 0,
        },
      };
    }),
  });
});

async function adminAdjustPlayerWallet(req, res, direction) {
  const amount = Math.round(Number(req.body?.amount));
  if (!Number.isFinite(amount) || amount < 1) {
    throw new ApiError("المبلغ غير صالح", 400);
  }
  const reason = String(req.body?.reason || "تعديل من الإدارة").slice(0, 200);
  const user = await User.findById(req.params.id).select("_id name email isBot");
  if (!user) throw new ApiError("اللاعب غير موجود", 404);

  try {
    await withMongoTransaction(async (session) => {
      if (direction === "credit") {
        await ledgerDeposit({
          session,
          userId: user._id,
          amount,
          ledgerType: "admin_grant",
          meta: {
            channel: "admin_dashboard",
            by: String(req.user._id),
            reason,
          },
        });
      } else {
        await ledgerWithdraw({
          session,
          userId: user._id,
          amount,
          ledgerType: "admin_player_debit",
          meta: {
            channel: "admin_dashboard",
            by: String(req.user._id),
            reason,
          },
        });
      }
    });
  } catch (err) {
    if (err?.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("رصيد اللاعب غير كافٍ", 402);
    }
    throw err;
  }

  await auditService.logEvent({
    event: direction === "credit" ? "admin_player_credit" : "admin_player_debit",
    actor: req.user._id,
    targetUser: user._id,
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null,
    meta: { amount, reason, direction },
  });

  const wallet = await getOrCreateWallet(user._id, null);
  res.status(200).json({
    status: "success",
    data: {
      userId: String(user._id),
      name: user.name,
      email: user.email,
      balance: wallet.balance,
      lockedBalance: wallet.lockedBalance,
      amount,
      direction,
    },
  });
}

exports.adminCreditPlayerWallet = asyncHandler((req, res) =>
  adminAdjustPlayerWallet(req, res, "credit")
);
exports.adminDebitPlayerWallet = asyncHandler((req, res) =>
  adminAdjustPlayerWallet(req, res, "debit")
);
