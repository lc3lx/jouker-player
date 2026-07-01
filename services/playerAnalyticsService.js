const PlayerAnalytics = require("../models/playerAnalyticsModel");

function isVoluntaryPreflop(action) {
  const t = String(action?.type || "");
  return ["call", "raise", "check", "fold"].includes(t);
}

function isRaise(action) {
  return String(action?.type || "") === "raise";
}

async function recordHandStats({ handId, gameType = "poker", seats = [], winners = [], pot = 0, actions = [] }) {
  const winnerIds = new Set(
    (winners || []).map((w) => String(w.user || w.userId || "")).filter(Boolean)
  );

  for (const seat of seats) {
    const uid = seat.user || seat.userId;
    if (!uid || seat.isBot) continue;

    const userActions = (actions || []).filter(
      (a) => String(a.playerId) === String(uid)
    );
    const sawFlop = (actions || []).some((a) => a.round === "flop" || a.type === "street");
    const voluntary = userActions.filter(isVoluntaryPreflop);
    const raised = userActions.filter(isRaise);
    const won = winnerIds.has(String(uid));
    const net = (seat.chipsAfter ?? seat.chips ?? 0) - (seat.chipsBefore ?? seat.handStartChips ?? 0);

    await PlayerAnalytics.findOneAndUpdate(
      { user: uid, gameType, period: "all" },
      {
        $inc: {
          handsPlayed: 1,
          handsWon: won ? 1 : 0,
          totalProfit: net,
          totalInvested: Math.max(0, -(net < 0 ? net : 0)),
          "rawCounters.voluntary": voluntary.length,
          "rawCounters.raises": raised.length,
          "rawCounters.sawShowdown": sawFlop ? 1 : 0,
        },
        $max: { biggestPotWon: won ? pot : 0 },
      },
      { upsert: true, new: true }
    );
  }
}

async function getUserAnalytics(userId, gameType = "poker") {
  const doc = await PlayerAnalytics.findOne({ user: userId, gameType, period: "all" }).lean();
  if (!doc) {
    return {
      handsPlayed: 0,
      handsWon: 0,
      vpip: 0,
      pfr: 0,
      winRate: 0,
      totalProfit: 0,
      roi: 0,
      avgPot: 0,
    };
  }
  const hands = doc.handsPlayed || 0;
  const voluntary = doc.rawCounters?.voluntary || 0;
  const raises = doc.rawCounters?.raises || 0;
  return {
    handsPlayed: hands,
    handsWon: doc.handsWon || 0,
    vpip: hands ? Math.round((voluntary / hands) * 1000) / 10 : 0,
    pfr: hands ? Math.round((raises / hands) * 1000) / 10 : 0,
    winRate: hands ? Math.round(((doc.handsWon || 0) / hands) * 1000) / 10 : 0,
    totalProfit: doc.totalProfit || 0,
    roi: doc.totalInvested
      ? Math.round(((doc.totalProfit || 0) / doc.totalInvested) * 1000) / 10
      : 0,
    avgPot: doc.avgPot || 0,
    biggestPotWon: doc.biggestPotWon || 0,
    longestWinStreak: doc.longestWinStreak || 0,
  };
}

module.exports = { recordHandStats, getUserAnalytics };
