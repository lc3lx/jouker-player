const HandEvidence = require("../models/handEvidenceModel");
const { buildHandAuditHash } = require("./auditService");
const auditService = require("./auditService");
const logger = require("../utils/logger");

function buildSearchableText(payload) {
  const parts = [
    payload.handId,
    payload.gameType,
    String(payload.table || ""),
    ...(payload.players || []).map((p) => p.name || p.userId || ""),
    payload.winner?.name,
    payload.winner?.handCategory,
  ];
  return parts.filter(Boolean).join(" ").slice(0, 8000);
}

/**
 * Persist immutable hand evidence package for customer support reconstruction.
 */
async function createHandEvidencePackage(payload) {
  const auditHash =
    payload.auditHash ||
    buildHandAuditHash({
      handId: payload.handId,
      table: payload.table,
      gameType: payload.gameType,
      actions: payload.actions || [],
      community: payload.communityCards || payload.community || [],
      pot: payload.pot,
      rake: payload.rake,
      winners: payload.winner ? [payload.winner] : [],
      seats: payload.players || [],
      provablyFair: payload.provablyFair,
    });

  const doc = await HandEvidence.findOneAndUpdate(
    { handId: payload.handId },
    {
      $set: {
        handId: payload.handId,
        gameType: payload.gameType,
        table: payload.table,
        handHistory: payload.handHistoryId,
        cardGameHistory: payload.cardGameHistoryId,
        replayData: payload.replayData,
        settlementSummary: payload.settlementSummary,
        auditHash,
        screenshot: payload.screenshotId,
        screenshotUrl: payload.screenshotUrl,
        screenshotChecksum: payload.screenshotChecksum,
        serverVersion: payload.serverVersion || process.env.APP_VERSION || "1.0.0",
        rulesVersion: payload.rulesVersion || process.env.RULES_VERSION || "1.0.0",
        players: payload.players || [],
        communityCards: payload.communityCards || [],
        holeCardsByPlayer: payload.holeCardsByPlayer || {},
        winner: payload.winner,
        potDistribution: payload.potDistribution,
        pot: payload.pot,
        durationMs: payload.durationMs,
        endedAt: payload.endedAt ? new Date(payload.endedAt) : new Date(),
        searchableText: buildSearchableText(payload),
      },
    },
    { upsert: true, new: true }
  );

  await auditService.logEvent({
    event: "hand_evidence_created",
    table: payload.table,
    handId: payload.handId,
    meta: { gameType: payload.gameType, auditHash, evidenceId: String(doc._id) },
  });

  return doc;
}

async function searchEvidence({ q, gameType, tableId, page = 1, limit = 20 }) {
  const filter = {};
  if (gameType) filter.gameType = gameType;
  if (tableId) filter.table = tableId;
  if (q && q.trim()) filter.$text = { $search: q.trim() };
  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    HandEvidence.find(filter).sort({ endedAt: -1 }).skip(skip).limit(limit).lean(),
    HandEvidence.countDocuments(filter),
  ]);
  return { data, total, page, limit };
}

async function getEvidenceByHandId(handId) {
  return HandEvidence.findOne({ handId }).lean();
}

module.exports = { createHandEvidencePackage, searchEvidence, getEvidenceByHandId };
