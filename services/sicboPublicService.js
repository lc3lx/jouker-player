/**
 * Sic Bo public REST handlers (player-facing): live state, history, my-bets, and
 * provably-fair verification. Betting itself happens over the /sicbo socket.
 */
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const SicBoRound = require("../models/sicboRoundModel");
const SicBoBet = require("../models/sicboBetModel");
const roundManager = require("../games/sicbo/sicboRoundManager");
const { getPublicStateForClient } = require("./sicboService");
const { verifyRound } = require("../games/sicbo/sicboSeed");
const { CHIP_DENOMINATIONS, BET_MIN, BET_CATALOG } = require("../games/sicbo/sicboConstants");

// GET /api/v1/sicbo/state
exports.getState = asyncHandler(async (req, res) => {
  const round = await getPublicStateForClient();
  let myBets = [];
  if (round?.roundId) myBets = await roundManager.getUserBets(round.roundId, req.user._id);
  res.status(200).json({
    status: "success",
    data: {
      round,
      myBets,
      config: {
        minBet: BET_MIN,
        chips: CHIP_DENOMINATIONS,
        betTypes: [...BET_CATALOG.entries()].map(([betType, odds]) => ({ betType, odds })),
      },
    },
  });
});

// GET /api/v1/sicbo/history?limit=30
exports.getHistory = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "30", 10)));
  const rounds = await SicBoRound.find({ status: "SETTLED", dice1: { $ne: null } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("roundId dice1 dice2 dice3 total resultBigSmall resultOddEven isTriple serverSeedHash createdAt")
    .lean();
  res.status(200).json({
    status: "success",
    results: rounds.length,
    data: rounds.map((r) => ({
      roundId: r.roundId,
      dice: [r.dice1, r.dice2, r.dice3],
      total: r.total,
      bigSmall: r.resultBigSmall,
      oddEven: r.resultOddEven,
      isTriple: r.isTriple,
      createdAt: r.createdAt,
    })),
  });
});

// GET /api/v1/sicbo/my-bets?limit=30
exports.getMyBets = asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "30", 10)));
  const bets = await SicBoBet.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.status(200).json({
    status: "success",
    results: bets.length,
    data: bets.map((b) => ({
      roundId: b.roundId,
      betType: b.betType,
      amount: b.amount,
      odds: b.odds,
      status: b.status,
      payout: b.payout,
      createdAt: b.createdAt,
    })),
  });
});

// GET /api/v1/sicbo/verify/:roundId  — provably-fair offline verification
exports.verify = asyncHandler(async (req, res, next) => {
  const round = await SicBoRound.findOne({ roundId: req.params.roundId }).lean();
  if (!round) return next(new ApiError("Round not found", 404));
  if (round.status !== "SETTLED" && round.status !== "RESULT") {
    return next(new ApiError("Round not yet revealed", 400));
  }
  const dice = [round.dice1, round.dice2, round.dice3];
  const check = verifyRound({
    serverSeed: round.serverSeed,
    serverSeedHash: round.serverSeedHash,
    clientSeed: round.clientSeed,
    nonce: round.nonce,
    dice,
  });
  res.status(200).json({
    status: "success",
    data: {
      roundId: round.roundId,
      serverSeed: round.serverSeed,
      serverSeedHash: round.serverSeedHash,
      clientSeed: round.clientSeed,
      nonce: round.nonce,
      dice,
      expectedDice: check.expectedDice,
      valid: check.valid,
      hashOk: check.hashOk,
      diceOk: check.diceOk,
    },
  });
});
