const HandHistory = require("../models/handHistoryModel");
const auditService = require("./auditService");
const replayService = require("./replayService");
const handScreenshotService = require("./handScreenshotService");
const playerAnalyticsService = require("./playerAnalyticsService");
const achievementHookService = require("./achievementHookService");
const logger = require("../utils/logger");

/**
 * Post-settlement archive hook — additive, fire-and-forget.
 * Called after poker hand Mongo write succeeds.
 */
async function onHandSettled({
  handId,
  handHistoryId,
  tableId,
  gameType = "poker",
  tableNumber = null,
  dealerSeatIndex = -1,
  smallBlind = 0,
  bigBlind = 0,
  startedAt = null,
  endedAt = null,
  community = [],
  pot = 0,
  rake = 0,
  winners = [],
  handCategory = null,
  seats = [],
  actions = [],
  auditLog = [],
}) {
  const ended = endedAt ? new Date(endedAt) : new Date();
  const started = startedAt ? new Date(startedAt) : ended;
  const durationMs = Math.max(0, ended.getTime() - started.getTime());

  const replayData = replayService.buildReplayDataFromEngine({
    handId,
    actions,
    community,
    seats,
    dealerSeatIndex,
    smallBlind,
    bigBlind,
    pot,
    rake,
    winners,
    handCategory,
    startedAt: started,
    endedAt: ended,
  });

  const auditHash = auditService.buildHandAuditHash({
    handId,
    table: tableId,
    gameType,
    actions,
    community,
    pot,
    rake,
    winners,
    seats,
    provablyFair: null,
  });

  const winnerNames = (winners || [])
    .map((w) => w.name || w.userId || "")
    .filter(Boolean)
    .join(", ");

  if (handHistoryId) {
    await HandHistory.findByIdAndUpdate(handHistoryId, {
      $set: {
        gameType,
        tableNumber,
        dealerSeatIndex,
        smallBlind,
        bigBlind,
        durationMs,
        replayData,
        auditHash,
        startedAt: started,
      },
    });
  }

  await handScreenshotService.generateHandScreenshot({
    handId,
    handHistoryId,
    tableId,
    gameType,
    auditHash,
    meta: {
      timestamp: ended.getTime(),
      pot,
      winnerNames,
      handCategory,
      community,
      seats: seats.map((s, i) => ({
        seatIndex: i,
        name: s.name || `Seat ${i}`,
        chipsAfter: s.chipsAfter ?? s.chips,
        hole: s.hole || [],
      })),
    },
  });

  void playerAnalyticsService.recordHandStats({
    handId,
    gameType,
    seats,
    winners,
    pot,
    rake,
    actions,
  }).catch((e) => {
    logger.warn("player_analytics_record_failed", { handId, reason: e?.message });
  });

  void achievementHookService.onHandCompleted({
    handId,
    gameType,
    seats,
    winners,
    handCategory,
    actions,
  }).catch((e) => {
    logger.warn("achievement_hook_failed", { handId, reason: e?.message });
  });

  await auditService.logEvent({
    event: "hand_settled",
    table: tableId,
    handId,
    meta: { gameType, pot, rake, auditHash, durationMs },
  });
}

module.exports = { onHandSettled };
