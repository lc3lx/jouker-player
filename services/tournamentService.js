const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Tournament = require("../models/tournamentModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const User = require("../models/userModel");

// Map tab to status
const tabToStatus = {
  ongoing: "ongoing",
  registering: "registering",
  season: "season",
  history: "history",
};

// List tournaments with tab filter
exports.listTournaments = asyncHandler(async (req, res) => {
  const tab = req.query.tab && tabToStatus[req.query.tab] ? req.query.tab : "ongoing";
  const filter = { status: tabToStatus[tab] };

  const page = parseInt(req.query.page || "1", 10);
  const limit = parseInt(req.query.limit || "20", 10);
  const skip = (page - 1) * limit;

  const total = await Tournament.countDocuments(filter);
  const items = await Tournament.find(filter)
    .sort({ startAt: 1 })
    .skip(skip)
    .limit(limit)
    .select("name prize entryFee durationMinutes startAt status participants");

  res.status(200).json({
    results: items.length,
    paginationResult: {
      currentPage: page,
      limit,
      numberOfPages: Math.ceil(total / limit),
      next: page * limit < total ? page + 1 : null,
    },
    data: items,
  });
});

// Get tournament by id
exports.getTournament = asyncHandler(async (req, res, next) => {
  const t = await Tournament.findById(req.params.id).populate({
    path: "participants.user",
    select: "name country profileImg",
  });
  if (!t) return next(new ApiError("Tournament not found", 404));
  res.status(200).json({ data: t });
});

// Create tournament (admin/manager)
exports.createTournament = asyncHandler(async (req, res) => {
  const t = await Tournament.create({
    name: req.body.name,
    prize: req.body.prize,
    entryFee: req.body.entryFee || 0,
    durationMinutes: req.body.durationMinutes,
    startAt: new Date(req.body.startAt),
    status: "registering",
  });
  res.status(201).json({ data: t });
});

// Register for tournament (protected)
exports.registerTournament = asyncHandler(async (req, res, next) => {
  const t = await Tournament.findById(req.params.id);
  if (!t) return next(new ApiError("Tournament not found", 404));
  if (t.status !== "registering") {
    return next(new ApiError("Registration closed", 400));
  }

  const already = t.participants.find((p) => String(p.user) === String(req.user._id));
  if (already) return next(new ApiError("Already registered", 400));

  // Wallet check
  let wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) wallet = await Wallet.create({ user: req.user._id });

  const fee = Number(t.entryFee || 0);
  if (fee > 0) {
    if (!wallet.hasSufficientBalance(fee)) {
      return next(new ApiError("Insufficient wallet balance", 400));
    }
    await wallet.addTransaction("debit", fee, `Tournament register: ${t.name}`);
  }

  const player = await Player.getOrCreateByUser(req.user._id);
  const user = await User.findById(req.user._id);
  t.participants.push({ user: req.user._id, player: player._id, country: user?.country });
  await t.save();

  res.status(200).json({
    status: "success",
    message: "Registered successfully",
    data: { rtcRoom: { roomId: t._id, type: "tournament" } },
  });
});

// Tournament leaderboard (simple: list participants; scoring can be extended later)
exports.getLeaderboard = asyncHandler(async (req, res, next) => {
  const t = await Tournament.findById(req.params.id).populate({
    path: "participants.user",
    select: "name country",
  });
  if (!t) return next(new ApiError("Tournament not found", 404));

  // Placeholder: no scoring logic persisted yet
  res.status(200).json({ results: t.participants.length, data: t.participants });
});
