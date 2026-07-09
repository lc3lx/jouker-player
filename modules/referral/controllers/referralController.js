"use strict";

const asyncHandler = require("express-async-handler");
const ApiError = require("../../../utils/apiError");
const User = require("../../../models/userModel");
const ReferralInviteeSnapshot = require("../models/referralInviteeSnapshotModel");
const referralInviteService = require("../services/referralInviteService");
const referralProgressService = require("../services/referralProgressService");
const referralAnalyticsService = require("../services/referralAnalyticsService");
const referralRewardService = require("../services/referralRewardService");
const referralDeepLinkService = require("../services/referralDeepLinkService");
const playerProgressRepository = require("../../playerProgress/repositories/playerProgressRepository");

exports.getMe = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const inviteCode = await referralInviteService.ensureInviteCode(userId);
  const links = referralDeepLinkService.buildLinks(inviteCode);
  const [progress, analytics] = await Promise.all([
    referralProgressService.getProgress(userId),
    referralAnalyticsService.getAnalytics(userId),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      inviteCode,
      links,
      progress,
      analytics,
    },
  });
});

exports.resolveCode = asyncHandler(async (req, res) => {
  const resolved = await referralInviteService.resolveInviteCode(req.params.code);
  if (!resolved.ok) throw new ApiError("كود الدعوة غير صالح", 404);
  res.status(200).json({
    status: "success",
    data: {
      referrerName: resolved.referrerName,
      valid: true,
    },
  });
});

exports.listInvitees = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
  const skip = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    ReferralInviteeSnapshot.find({ referrerId: req.user._id })
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ReferralInviteeSnapshot.countDocuments({ referrerId: req.user._id }),
  ]);

  const userIds = rows.map((r) => r.inviteeId);
  const users = await User.find({ _id: { $in: userIds } }).select("name profileImg createdAt").lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  res.status(200).json({
    status: "success",
    results: rows.length,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    data: rows.map((r) => {
      const u = userMap.get(String(r.inviteeId));
      return {
        id: String(r.inviteeId),
        name: u?.name || "لاعب",
        profileImg: u?.profileImg || "",
        level: r.level || 1,
        qualifiedTiers: r.qualifiedTiers || [],
        registeredAt: r.registeredAt || u?.createdAt,
        lastActiveAt: r.lastActiveAt,
      };
    }),
  });
});

exports.claimMilestone = asyncHandler(async (req, res) => {
  const tierId = req.params.tierId;
  const clientSignals = req.body?.clientSignals || {};
  const row = await referralRewardService.requestClaim(req.user._id, tierId, clientSignals);
  res.status(200).json({
    status: "success",
    data: {
      rewardId: String(row._id),
      status: row.status,
      autoApproved: row.autoApproved === true,
    },
  });
});

exports.getXpHistory = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "30", 10);
  const payload = await playerProgressRepository.listXpHistory(req.user._id, { page, limit });
  res.status(200).json({ status: "success", data: payload });
});
