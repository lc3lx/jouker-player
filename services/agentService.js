const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const AgentProfile = require("../models/agentProfileModel");
const SystemSettings = require("../models/systemSettingsModel");
const Wallet = require("../models/walletModel");
const User = require("../models/userModel");

exports.applyAgent = asyncHandler(async (req, res, next) => {
  const { roleType } = req.body;
  if (!roleType || !["agent", "promoter"].includes(roleType)) {
    return next(new ApiError("Invalid roleType", 400));
  }
  let profile = await AgentProfile.findOne({ user: req.user._id });
  const defaults = await SystemSettings.getDefaults();
  if (!profile) {
    profile = await AgentProfile.create({
      user: req.user._id,
      roleType,
      referralCode: AgentProfile.generateReferralCode(),
      salesCommissionPercent: defaults.defaultSalesCommissionPercent,
      referralCommissionPercent: defaults.defaultReferralCommissionPercent,
    });
  } else {
    if (profile.status === "suspended") return next(new ApiError("Profile suspended", 403));
    profile.roleType = roleType;
    if (!profile.referralCode) profile.referralCode = AgentProfile.generateReferralCode();
    if (profile.salesCommissionPercent == null) profile.salesCommissionPercent = defaults.defaultSalesCommissionPercent;
    if (profile.referralCommissionPercent == null) profile.referralCommissionPercent = defaults.defaultReferralCommissionPercent;
    await profile.save();
  }
  res.status(200).json({ status: "success", data: profile });
});

exports.getMyAgentProfile = asyncHandler(async (req, res) => {
  const profile = await AgentProfile.findOne({ user: req.user._id });
  if (!profile) return res.status(200).json({ status: "success", data: null });
  res.status(200).json({ status: "success", data: profile });
});

exports.listMyReferrals = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const skip = (page - 1) * limit;
  const users = await User.find({ referredBy: req.user._id }).select("name email createdAt").skip(skip).limit(limit).sort({ createdAt: -1 });
  const total = await User.countDocuments({ referredBy: req.user._id });
  res.status(200).json({ status: "success", results: users.length, paginationResult: { currentPage: page, limit, numberOfPages: Math.ceil(total/limit), next: page*limit<total? page+1 : null }, data: users });
});

exports.listAgents = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page || "1", 10);
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
  const skip = (page - 1) * limit;
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.roleType) filter.roleType = req.query.roleType;
  const items = await AgentProfile.find(filter).populate("user", "name email").skip(skip).limit(limit).sort({ createdAt: -1 });
  const total = await AgentProfile.countDocuments(filter);
  res.status(200).json({ status: "success", results: items.length, paginationResult: { currentPage: page, limit, numberOfPages: Math.ceil(total/limit), next: page*limit<total? page+1 : null }, data: items });
});

exports.approveAgent = asyncHandler(async (req, res, next) => {
  const { status, salesCommissionPercent, referralCommissionPercent, referralCode } = req.body;
  const profile = await AgentProfile.findById(req.params.id);
  if (!profile) return next(new ApiError("Profile not found", 404));
  if (status) profile.status = status;
  if (salesCommissionPercent != null) profile.salesCommissionPercent = salesCommissionPercent;
  if (referralCommissionPercent != null) profile.referralCommissionPercent = referralCommissionPercent;
  if (referralCode) profile.referralCode = referralCode.toUpperCase();
  await profile.save();
  res.status(200).json({ status: "success", data: profile });
});

exports.getSettings = asyncHandler(async (req, res) => {
  const s = await SystemSettings.getDefaults();
  res.status(200).json({ status: "success", data: s });
});

exports.updateSettings = asyncHandler(async (req, res) => {
  const s = await SystemSettings.getDefaults();
  if (req.body.defaultSalesCommissionPercent != null) s.defaultSalesCommissionPercent = req.body.defaultSalesCommissionPercent;
  if (req.body.defaultReferralCommissionPercent != null) s.defaultReferralCommissionPercent = req.body.defaultReferralCommissionPercent;
  await s.save();
  res.status(200).json({ status: "success", data: s });
});

exports.topupByAgent = asyncHandler(async (req, res, next) => {
  const { targetUserId, amount, description } = req.body;
  if (!targetUserId || !amount || amount <= 0) return next(new ApiError("Invalid input", 400));
  const profile = await AgentProfile.findOne({ user: req.user._id });
  if (!profile || profile.status !== "approved") return next(new ApiError("Not an approved agent", 403));
  const agentWallet = await Wallet.findOne({ user: req.user._id });
  if (!agentWallet) return next(new ApiError("Agent wallet not found", 404));
  if (!agentWallet.hasSufficientBalance(amount)) return next(new ApiError("Insufficient balance", 400));
  const targetUser = await User.findById(targetUserId);
  if (!targetUser) return next(new ApiError("Target user not found", 404));
  let targetWallet = await Wallet.findOne({ user: targetUser._id });
  if (!targetWallet) targetWallet = await Wallet.create({ user: targetUser._id });
  await agentWallet.addTransaction("debit", amount, description || `Agent topup to ${targetUser.email}`);
  await targetWallet.addTransaction("credit", amount, description || `Topup by agent ${req.user.email || req.user._id}`);
  const percent = profile.salesCommissionPercent != null ? profile.salesCommissionPercent : (await SystemSettings.getDefaults()).defaultSalesCommissionPercent;
  const commission = Math.floor(amount * percent);
  if (commission > 0) {
    await agentWallet.addTransaction("credit", commission, "Agent topup commission");
  }
  profile.stats.totalTopups += 1;
  profile.stats.totalVolume += amount;
  profile.stats.totalCommission += commission;
  await profile.save();
  res.status(200).json({ status: "success", data: { credited: amount, commission } });
});
