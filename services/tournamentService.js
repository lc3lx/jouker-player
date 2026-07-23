/**
 * @deprecated Legacy standalone-tournament REST controller layer. No longer
 * reachable — routes/tournamentRoute.js was rewritten to a disable gate that
 * doesn't require this file at all, so nothing in this module executes in
 * production. Replaced by the ClanTournament bracket system
 * (services/clanTournamentEngineService.js). Reason: registerTournament
 * below debits the wallet non-transactionally before registration confirms,
 * with no refund path on failure — see
 * docs/STANDALONE_TOURNAMENT_DISABLED.md for the full audit. Kept, not
 * deleted, for database compatibility and a possible future migration. Do
 * not wire this module into any new route/service/socket handler.
 */
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const Tournament = require("../models/tournamentModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const User = require("../models/userModel");
const tournamentEngine = require("./tournamentEngineService");
const auditService = require("./auditService");

const tabToStatus = {
  ongoing: "ongoing",
  registering: "registering",
  season: "season",
  history: "history",
};

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
    .select("name prize entryFee durationMinutes startAt status lifecycle tournamentType participants prizePool");

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

exports.getTournament = asyncHandler(async (req, res, next) => {
  const t = await Tournament.findById(req.params.id).populate({
    path: "participants.user",
    select: "name country profileImg",
  });
  if (!t) return next(new ApiError("Tournament not found", 404));
  res.status(200).json({ data: t });
});

exports.createTournament = asyncHandler(async (req, res) => {
  const t = await tournamentEngine.createTournament({
    name: req.body.name,
    prize: req.body.prize,
    entryFee: req.body.entryFee || 0,
    durationMinutes: req.body.durationMinutes,
    startAt: new Date(req.body.startAt),
    tournamentType: req.body.tournamentType,
    lateRegistrationMinutes: req.body.lateRegistrationMinutes,
    blindSchedule: req.body.blindSchedule,
    prizeDistribution: req.body.prizeDistribution,
    settings: req.body.settings,
    isPrivate: req.body.isPrivate,
  });
  res.status(201).json({ data: t });
});

exports.registerTournament = asyncHandler(async (req, res, next) => {
  const t = await Tournament.findById(req.params.id);
  if (!t) return next(new ApiError("Tournament not found", 404));

  const already = t.participants.find((p) => String(p.user) === String(req.user._id));
  if (already) return next(new ApiError("Already registered", 400));

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
  const updated = await tournamentEngine.registerPlayer(t._id, req.user._id);
  if (!updated.participants.some((p) => p.player)) {
    await Tournament.findOneAndUpdate(
      { _id: t._id, "participants.user": req.user._id },
      { $set: { "participants.$.player": player._id, "participants.$.country": user?.country } }
    );
  }

  await auditService.logEvent({
    event: "tournament_register",
    actor: req.user._id,
    tournament: t._id,
  });

  res.status(200).json({
    status: "success",
    message: "Registered successfully",
    data: { rtcRoom: { roomId: t._id, type: "tournament" } },
  });
});

exports.getLeaderboard = asyncHandler(async (req, res) => {
  const data = await tournamentEngine.getLeaderboard(req.params.id);
  res.status(200).json({ results: data.length, data });
});

exports.getLobby = asyncHandler(async (req, res) => {
  const data = await tournamentEngine.getTournamentLobby();
  res.status(200).json({ results: data.length, data });
});

exports.getStatistics = asyncHandler(async (req, res) => {
  const data = await tournamentEngine.getTournamentStatistics(req.params.id);
  res.status(200).json({ data });
});
