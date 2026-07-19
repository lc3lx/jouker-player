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
const auditService = require("./auditService");
const playerProfileService = require("./playerProfileService");

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
  const user = await User.findById(req.params.id).select("_id active muted");
  if (!user) throw new ApiError("User not found", 404);
  Object.assign(user, set);
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
