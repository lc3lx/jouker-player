const Clan = require("../models/clanModel");
const clanService = require("./clanService");

const SCOPES = new Set([
  "global",
  "country",
  "weekly",
  "monthly",
  "most_active",
  "most_tournament_wins",
  "highest_win_rate",
]);

const MIN_GAMES_FOR_WINRATE = 20;

function sortForScope(scope) {
  switch (scope) {
    case "weekly":
      return { "stats.weeklyActivity": -1, "stats.rankScore": -1 };
    case "monthly":
      return { "stats.monthlyActivity": -1, "stats.rankScore": -1 };
    case "most_active":
      return { "stats.gamesPlayed": -1 };
    case "most_tournament_wins":
      return { "stats.tournamentWins": -1 };
    case "global":
    case "country":
    default:
      return { "stats.rankScore": -1, memberCount: -1 };
  }
}

/**
 * Clan leaderboards. Most scopes are a simple indexed sort; highest_win_rate uses
 * an aggregation (computed winRate with a minimum-games gate to avoid tiny-sample
 * inflation).
 */
async function getLeaderboard({ scope = "global", country, page = 1, limit = 25 } = {}) {
  const s = SCOPES.has(scope) ? scope : "global";
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const baseFilter = { status: "active" };
  if (s === "country") {
    if (!country) return { scope: s, total: 0, page: pg, limit: lim, data: [] };
    baseFilter.country = String(country).toUpperCase();
  }

  if (s === "highest_win_rate") {
    const rows = await Clan.aggregate([
      { $match: { ...baseFilter, "stats.gamesPlayed": { $gte: MIN_GAMES_FOR_WINRATE } } },
      {
        $addFields: {
          winRate: {
            $cond: [
              { $gt: ["$stats.gamesPlayed", 0] },
              { $divide: ["$stats.wins", "$stats.gamesPlayed"] },
              0,
            ],
          },
        },
      },
      { $sort: { winRate: -1, "stats.gamesPlayed": -1 } },
      { $skip: (pg - 1) * lim },
      { $limit: lim },
    ]);
    return {
      scope: s,
      page: pg,
      limit: lim,
      data: rows.map((c, i) => ({
        rank: (pg - 1) * lim + i + 1,
        ...clanService.serializeSummary(c),
        winRate: Number(c.winRate || 0),
      })),
    };
  }

  const [rows, total] = await Promise.all([
    Clan.find(baseFilter)
      .sort(sortForScope(s))
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    Clan.countDocuments(baseFilter),
  ]);
  return {
    scope: s,
    total,
    page: pg,
    limit: lim,
    data: rows.map((c, i) => ({
      rank: (pg - 1) * lim + i + 1,
      ...clanService.serializeSummary(c),
      metric: metricFor(s, c),
    })),
  };
}

function metricFor(scope, clan) {
  const st = clan.stats || {};
  switch (scope) {
    case "weekly":
      return st.weeklyActivity || 0;
    case "monthly":
      return st.monthlyActivity || 0;
    case "most_active":
      return st.gamesPlayed || 0;
    case "most_tournament_wins":
      return st.tournamentWins || 0;
    default:
      return st.rankScore || 0;
  }
}

module.exports = { getLeaderboard, SCOPES };
