const Player = require("../models/playerModel");
const logger = require("../utils/logger");
const { publish } = require("../domain/events/domainEventBus");
const Events = require("../domain/events/eventTypes");

function safeGameType(gameType) {
  const raw = String(gameType || "game").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return raw.slice(0, 32) || "game";
}

function buildStatsInc({ won, gameType }) {
  const type = safeGameType(gameType);
  const inc = {
    "stats.gamesPlayed": 1,
    [`stats.byGame.${type}.played`]: 1,
  };
  if (won) {
    inc["stats.wins"] = 1;
    inc[`stats.byGame.${type}.wins`] = 1;
  }
  return inc;
}

/**
 * Count a finished match/spin for leaderboards + profile wins.
 * Safe to call fire-and-forget; never throws to the caller.
 */
async function recordOutcome({ userId, gameType, won = false, sourceId = "" } = {}) {
  const uid = userId != null ? String(userId) : "";
  if (!uid) return null;
  try {
    const player = await Player.getOrCreateByUser(uid);
    const inc = buildStatsInc({ won: won === true, gameType });
    await Player.updateOne({ _id: player._id }, { $inc: inc });
    return inc;
  } catch (err) {
    logger.warn("player_win_stats_failed", {
      userId: uid,
      gameType: safeGameType(gameType),
      sourceId: sourceId ? String(sourceId) : "",
      reason: err?.message || "unknown",
    });
    return null;
  }
}

function publishCompletedGame({ userId, gameType, won, sourceId }) {
  if (!userId) return;
  publish(Events.PLAYER_COMPLETED_GAME, {
    userId: String(userId),
    gameType: safeGameType(gameType),
    won: won === true,
    sourceId: sourceId ? String(sourceId) : "",
  });
}

/** Record every human participant of a completed card-game / parkour settlement. */
function publishFromSettlement(settlement) {
  if (!settlement || settlement.settlementStatus === "failed") return;
  const gameType = settlement.gameType || "game";
  const sourceId = settlement.settlementId || "";
  const rows = Array.isArray(settlement.participants) ? settlement.participants : [];
  for (const p of rows) {
    if (!p || p.isBot || !p.userId) continue;
    publishCompletedGame({
      userId: p.userId,
      gameType,
      won: p.isWinner === true,
      sourceId,
    });
  }
}

module.exports = {
  safeGameType,
  buildStatsInc,
  recordOutcome,
  publishCompletedGame,
  publishFromSettlement,
};
