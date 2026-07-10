"use strict";

const asyncHandler = require("express-async-handler");
const referralAnalyticsService = require("../modules/referral/services/referralAnalyticsService");
const referralRewardService = require("../modules/referral/services/referralRewardService");
const referralProgressService = require("../modules/referral/services/referralProgressService");
const referralAuditService = require("../modules/referral/services/referralAuditService");
const ReferralFraudProfile = require("../modules/fraud/models/referralFraudProfileModel");
const ReferralProgress = require("../modules/referral/models/referralProgressModel");
const QualificationRecord = require("../modules/qualification/models/qualificationRecordModel");
const playerProgressRepository = require("../modules/playerProgress/repositories/playerProgressRepository");

exports.listAnalytics = asyncHandler(async (req, res) => {
  const data = await referralAnalyticsService.listAnalytics({
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ status: "success", data });
});

exports.getReferrerAnalytics = asyncHandler(async (req, res) => {
  const analytics = await referralAnalyticsService.getAnalytics(req.params.referrerId);
  const progress = await referralProgressService.getProgress(req.params.referrerId);
  res.status(200).json({ status: "success", data: { analytics, progress } });
});

exports.getFraudProfile = asyncHandler(async (req, res) => {
  const profile = await ReferralFraudProfile.findOne({ userId: req.params.userId }).lean();
  res.status(200).json({ status: "success", data: profile });
});

exports.listRewards = asyncHandler(async (req, res) => {
  const data = await referralRewardService.listRewards({
    status: req.query.status,
    referrerId: req.query.referrerId,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ status: "success", data });
});

exports.approveReward = asyncHandler(async (req, res) => {
  const row = await referralRewardService.approveReward(req.params.id, req.user._id, { auto: false });
  res.status(200).json({ status: "success", data: row });
});

exports.rejectReward = asyncHandler(async (req, res) => {
  const row = await referralRewardService.rejectReward(
    req.params.id,
    req.user._id,
    req.body?.reason || ""
  );
  res.status(200).json({ status: "success", data: row });
});

exports.suspendReferrer = asyncHandler(async (req, res) => {
  await Promise.all([
    ReferralProgress.findOneAndUpdate(
      { referrerId: req.params.id },
      { $set: { suspended: true, suspendedReason: "admin" } },
      { upsert: true }
    ),
    ReferralFraudProfile.findOneAndUpdate(
      { userId: req.params.id },
      { $set: { suspended: true, suspendedReason: "admin" } },
      { upsert: true }
    ),
  ]);
  void referralAuditService.append({
    action: "admin_suspend",
    referrerId: req.params.id,
    actorId: req.user._id,
    meta: { reason: req.body?.reason || "" },
  });
  res.status(200).json({ status: "success" });
});

exports.whitelistReferrer = asyncHandler(async (req, res) => {
  await Promise.all([
    ReferralProgress.findOneAndUpdate(
      { referrerId: req.params.id },
      { $set: { whitelisted: true, suspended: false, suspendedReason: null } },
      { upsert: true }
    ),
    ReferralFraudProfile.findOneAndUpdate(
      { userId: req.params.id },
      { $set: { whitelisted: true, suspended: false, suspendedReason: null, score: 0, band: "safe" } },
      { upsert: true }
    ),
  ]);
  void referralAuditService.append({
    action: "admin_whitelist",
    referrerId: req.params.id,
    actorId: req.user._id,
  });
  void referralAuditService.append({
    action: "fraud_cleared",
    referrerId: req.params.id,
    actorId: req.user._id,
  });
  res.status(200).json({ status: "success" });
});

exports.blacklistReferrer = asyncHandler(async (req, res) => {
  await Promise.all([
    ReferralProgress.findOneAndUpdate(
      { referrerId: req.params.id },
      { $set: { blacklisted: true, suspended: true } },
      { upsert: true }
    ),
    ReferralFraudProfile.findOneAndUpdate(
      { userId: req.params.id },
      { $set: { blacklisted: true, suspended: true, score: 100, band: "manual_review" } },
      { upsert: true }
    ),
  ]);
  void referralAuditService.append({
    action: "admin_blacklist",
    referrerId: req.params.id,
    actorId: req.user._id,
    meta: { reason: req.body?.reason || "" },
  });
  res.status(200).json({ status: "success" });
});

exports.recalculate = asyncHandler(async (req, res) => {
  const progress = await referralProgressService.recalculateProgress(req.params.id);
  res.status(200).json({ status: "success", data: progress });
});

exports.listXpHistory = asyncHandler(async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ status: "error", message: "userId required" });
  const data = await playerProgressRepository.listXpHistory(userId, {
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ status: "success", data });
});

exports.listQualifications = asyncHandler(async (req, res) => {
  const q = {};
  if (req.query.userId) q.userId = req.query.userId;
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, parseInt(req.query.limit || "30", 10));
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    QualificationRecord.find(q).sort({ qualifiedAt: -1 }).skip(skip).limit(limit).lean(),
    QualificationRecord.countDocuments(q),
  ]);
  res.status(200).json({ status: "success", data: { rows, total, page, limit } });
});

exports.exportReport = asyncHandler(async (req, res) => {
  const data = await referralAnalyticsService.listAnalytics({ page: 1, limit: 500 });
  res.status(200).json({ status: "success", format: "json", data });
});

exports.listAuditLog = asyncHandler(async (req, res) => {
  const data = await referralAuditService.list({
    referrerId: req.query.referrerId,
    inviteeId: req.query.inviteeId,
    action: req.query.action,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json({ status: "success", data });
});
