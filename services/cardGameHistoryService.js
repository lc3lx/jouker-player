const crypto = require("crypto");
const CardGameHistory = require("../models/cardGameHistoryModel");
const handScreenshotService = require("./handScreenshotService");
const handEvidenceService = require("./handEvidenceService");
const replayService = require("./replayService");
const playerAnalyticsService = require("./playerAnalyticsService");
const auditService = require("./auditService");
const logger = require("../utils/logger");

function sessionHandId(gameType, tableId, sessionId) {
  return `${gameType}-${tableId}-${sessionId || Date.now()}`;
}

function buildAuditHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/**
 * Archive completed Trix/Tarneeb41 match — called after settlement succeeds.
 */
async function archiveCardGameMatch({
  gameType,
  tableId,
  tableNumber,
  sessionId,
  gameResult,
  gamePlayers,
  settlement,
  game,
}) {
  const endedAt = new Date();
  const handId = sessionHandId(gameType, tableId, sessionId);
  const actions = game?.actionLog || game?.currentHandActions || [];
  const rounds = [];

  if (gameType === "trix" && game?.getRoundResult) {
    try {
      for (let r = 1; r <= (game.roundNumber || 0); r++) {
        rounds.push({ round: r, scores: game.gameState?.scores || gameResult?.scores });
      }
    } catch (_) {
      /* optional */
    }
  }

  const replayData = {
    version: 1,
    gameType,
    handId,
    tableId: String(tableId),
    sessionId,
    players: (gamePlayers || []).map((p, i) => ({
      seatIndex: i,
      userId: p.userId || p.id,
      name: p.name || `Player ${i + 1}`,
    })),
    rounds,
    actions,
    gameResult,
    settlementSummary: settlement
      ? {
          settlementId: settlement.settlementId,
          totalPayout: settlement.totalPayout,
          totalRake: settlement.totalRake,
          reconciliation: settlement.reconciliation,
        }
      : null,
    endedAt,
  };

  const auditHash = buildAuditHash(replayData);

  const history = await CardGameHistory.create({
    sessionId: sessionId || handId,
    gameType,
    table: tableId,
    tableNumber,
    players: replayData.players,
    rounds,
    actions,
    gameResult,
    settlementId: settlement?.settlementId,
    settlementSummary: replayData.settlementSummary,
    replayData,
    auditHash,
    endedAt,
    startedAt: game?.startedAt || endedAt,
    durationMs: game?.startedAt ? endedAt - new Date(game.startedAt) : 0,
    searchableText: [handId, gameType, String(tableId)].join(" "),
  });

  let screenshot = null;
  try {
    screenshot = await handScreenshotService.generateHandScreenshot({
      handId,
      handHistoryId: null,
      tableId,
      gameType,
      auditHash,
      meta: {
        timestamp: endedAt.getTime(),
        pot: settlement?.totalPayout || 0,
        winnerNames: JSON.stringify(gameResult?.winnerTeam ?? gameResult?.winnerIndex ?? ""),
        handCategory: gameType,
        community: [],
        seats: replayData.players.map((p) => ({
          seatIndex: p.seatIndex,
          name: p.name,
          chipsAfter: 0,
          hole: [],
        })),
      },
    });
  } catch (e) {
    logger.warn("card_game_screenshot_failed", { handId, reason: e?.message });
  }

  const evidence = await handEvidenceService.createHandEvidencePackage({
    handId,
    gameType,
    table: tableId,
    cardGameHistoryId: history._id,
    replayData,
    settlementSummary: replayData.settlementSummary,
    auditHash,
    screenshotId: screenshot?._id,
    screenshotUrl: screenshot?.publicUrl,
    screenshotChecksum: screenshot?.snapshotMeta?.checksum,
    players: replayData.players,
    winner: gameResult,
    pot: settlement?.totalPayout,
    durationMs: history.durationMs,
    endedAt,
  });

  await CardGameHistory.findByIdAndUpdate(history._id, { evidence: evidence._id });

  void playerAnalyticsService.recordCardGameMatch({
    gameType,
    gameResult,
    players: replayData.players,
    settlement,
  }).catch(() => {});

  await auditService.logEvent({
    event: "card_game_archived",
    table: tableId,
    handId,
    meta: { gameType, cardGameHistoryId: String(history._id) },
  });

  return { history, evidence, replay: replayService.buildReplayPayload({ ...history.toObject(), handId }) };
}

module.exports = { archiveCardGameMatch, sessionHandId };
