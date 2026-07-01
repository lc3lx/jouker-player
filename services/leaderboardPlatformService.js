const User = require("../models/userModel");
const HandHistory = require("../models/handHistoryModel");
const GameSettlement = require("../models/gameSettlementModel");

function periodStart(period) {
  const now = new Date();
  if (period === "daily") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === "weekly") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  if (period === "monthly") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return null;
}

async function pokerLeaderboard({ period = "weekly", metric = "wins", limit = 50 }) {
  const since = periodStart(period);
  const match = { gameType: "poker" };
  if (since) match.endedAt = { $gte: since };

  if (metric === "hands") {
    const rows = await HandHistory.aggregate([
      { $match: match },
      { $unwind: "$players" },
      { $group: { _id: "$players.user", hands: { $sum: 1 } } },
      { $sort: { hands: -1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => ({ userId: String(r._id), value: r.hands }));
  }

  if (metric === "biggest_pot") {
    const rows = await HandHistory.aggregate([
      { $match: match },
      { $unwind: "$winners" },
      { $group: { _id: "$winners.user", biggestPot: { $max: "$pot" } } },
      { $sort: { biggestPot: -1 } },
      { $limit: limit },
    ]);
    return rows.map((r) => ({ userId: String(r._id), value: r.biggestPot }));
  }

  const sortField = metric === "profit" ? "pokerWeeklyProfit" : "pokerHandsWon";
  const users = await User.find({ [sortField]: { $gt: 0 } })
    .sort({ [sortField]: -1 })
    .limit(limit)
    .select("name profileImg country pokerHandsWon pokerWinStreak")
    .lean();

  return users.map((u) => ({
    userId: String(u._id),
    name: u.name,
    avatar: u.profileImg,
    country: u.country,
    value: u[sortField] || u.pokerHandsWon || 0,
    winStreak: u.pokerWinStreak || 0,
  }));
}

async function settlementProfitLeaderboard({ period = "monthly", gameType = null, limit = 50 }) {
  const since = periodStart(period);
  const match = {};
  if (since) match.createdAt = { $gte: since };
  if (gameType) match.gameType = gameType;

  const rows = await GameSettlement.aggregate([
    { $match: match },
    { $unwind: "$participants" },
    { $match: { "participants.isBot": { $ne: true } } },
    { $group: { _id: "$participants.userId", profit: { $sum: "$participants.netDelta" } } },
    { $sort: { profit: -1 } },
    { $limit: limit },
  ]);
  return rows.map((r) => ({ userId: String(r._id), profit: r.profit }));
}

module.exports = {
  pokerLeaderboard,
  settlementProfitLeaderboard,
};
