/**
 * Sic Bo admin monitoring: live round, active players, totals, house profit, RTP,
 * failed settlements, and stuck rounds.
 */
const asyncHandler = require("express-async-handler");
const SicBoRound = require("../models/sicboRoundModel");
const SicBoBet = require("../models/sicboBetModel");
const { getRealisedRtp } = require("../games/sicbo/sicboRtp");

// GET /api/v1/admin/sicbo/monitor
exports.getMonitor = asyncHandler(async (req, res) => {
  const [current, rtp, stuck, failed, last24hAgg] = await Promise.all([
    SicBoRound.findOne().sort({ createdAt: -1 }).lean(),
    getRealisedRtp(),
    SicBoRound.find({
      status: { $in: ["BETTING", "LOCKED", "ROLLING", "RESULT"] },
      createdAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) },
    })
      .sort({ createdAt: 1 })
      .limit(50)
      .select("roundId status createdAt settlementError settledCount expectedSettlements")
      .lean(),
    SicBoRound.find({ settlementError: { $ne: null } })
      .sort({ createdAt: -1 })
      .limit(50)
      .select("roundId status settlementError settledCount expectedSettlements createdAt")
      .lean(),
    SicBoRound.aggregate([
      { $match: { status: "SETTLED", createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } } },
      {
        $group: {
          _id: null,
          rounds: { $sum: 1 },
          totalBetAmount: { $sum: "$totalBetAmount" },
          totalPayout: { $sum: "$totalPayout" },
          houseProfit: { $sum: "$houseProfit" },
        },
      },
    ]),
  ]);

  let activePlayers = 0;
  if (current?.roundId) {
    const players = await SicBoBet.distinct("userId", { roundId: current.roundId });
    activePlayers = players.length;
  }

  const day = last24hAgg[0] || { rounds: 0, totalBetAmount: 0, totalPayout: 0, houseProfit: 0 };

  res.status(200).json({
    status: "success",
    data: {
      currentRound: current
        ? {
            roundId: current.roundId,
            status: current.status,
            bettingEnd: current.bettingEnd,
            totalBetAmount: current.totalBetAmount,
            totalPayout: current.totalPayout,
            houseProfit: current.houseProfit,
            activePlayers,
          }
        : null,
      rtp: {
        realisedRtp: rtp.rtp,
        houseEdge: rtp.houseEdge,
        totalBet: rtp.totalBet,
        totalPayout: rtp.totalPayout,
        rounds: rtp.rounds,
      },
      last24h: day,
      stuckRounds: stuck,
      failedSettlements: failed,
    },
  });
});

// GET /api/v1/admin/sicbo/rounds?limit=50
exports.listRounds = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50", 10)));
  const rounds = await SicBoRound.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      "roundId status dice1 dice2 dice3 total totalPlayers totalBetAmount totalPayout houseProfit settlementError createdAt settledAt"
    )
    .lean();
  res.status(200).json({ status: "success", results: rounds.length, data: rounds });
});
