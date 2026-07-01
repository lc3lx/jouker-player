const HandHistory = require("../models/handHistoryModel");
const CardGameHistory = require("../models/cardGameHistoryModel");
const ApiError = require("../utils/apiError");

function buildReplaySteps(doc) {
  const replay = doc.replayData;
  if (replay && Array.isArray(replay.steps)) return replay.steps;

  const steps = [];
  const actions = Array.isArray(doc.actions) ? doc.actions : [];
  for (const a of actions) {
    steps.push({
      type: "action",
      ts: a.ts,
      round: a.round,
      action: a.type,
      playerId: a.playerId,
      seatIndex: a.seatIndex,
      amount: a.amount || 0,
      callAmount: a.callAmount || 0,
    });
  }
  return steps;
}

function buildReplayPayload(doc) {
  return {
    handId: doc.handId,
    tableId: String(doc.table),
    gameType: doc.gameType || "poker",
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    durationMs: doc.durationMs,
    dealerSeatIndex: doc.dealerSeatIndex,
    smallBlind: doc.smallBlind,
    bigBlind: doc.bigBlind,
    community: doc.community || [],
    pot: doc.pot,
    rake: doc.rake,
    winners: doc.winners || [],
    handCategory: doc.handCategory,
    seats: doc.seats || [],
    auditHash: doc.auditHash,
    screenshot: doc.screenshot ? String(doc.screenshot) : null,
    steps: buildReplaySteps(doc),
    provablyFair: doc.provablyFair || null,
  };
}

async function getHandReplay(handId, { revealSeed = false } = {}) {
  let doc = await HandHistory.findOne({ handId }).lean();
  if (!doc) {
    doc = await CardGameHistory.findOne({ sessionId: handId }).lean();
    if (!doc) {
      const byReplay = await CardGameHistory.findOne({ "replayData.handId": handId }).lean();
      doc = byReplay;
    }
  }
  if (!doc) throw new ApiError("Hand not found", 404);
  const payload = buildReplayPayload(doc);
  if (!revealSeed && payload.provablyFair) {
    payload.provablyFair = {
      serverSeedHash: payload.provablyFair.serverSeedHash,
      clientSeedDigest: payload.provablyFair.clientSeedDigest,
      handId: payload.provablyFair.handId,
    };
  }
  return payload;
}

function buildReplayDataFromEngine({
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
  startedAt,
  endedAt,
}) {
  const steps = [];
  let street = "preflop";
  for (const a of actions || []) {
    if (a.type === "street") {
      street = a.street || street;
      steps.push({ type: "street", street, ts: a.ts });
      continue;
    }
    if (a.type === "blind") {
      steps.push({
        type: "blind",
        ts: a.ts,
        seatIndex: a.seatIndex,
        amount: a.amount,
        blind: a.blind,
      });
      continue;
    }
    steps.push({
      type: "action",
      ts: a.ts,
      round: a.round || street,
      action: a.type,
      playerId: a.playerId,
      seatIndex: a.seatIndex,
      amount: a.amount || 0,
      callAmount: a.callAmount || 0,
    });
  }
  steps.push({
    type: "showdown",
    ts: endedAt || Date.now(),
    community: community || [],
    winners: winners || [],
    handCategory: handCategory || null,
  });

  return {
    version: 1,
    handId,
    dealerSeatIndex,
    smallBlind,
    bigBlind,
    startedAt,
    endedAt,
    pot,
    rake,
    seats: (seats || []).map((s, i) => ({
      seatIndex: i,
      userId: s.userId || (s.user ? String(s.user) : null),
      name: s.name,
      chipsBefore: s.chipsBefore ?? s.handStartChips,
      chipsAfter: s.chipsAfter ?? s.chips,
      hole: s.hole || [],
      folded: !!s.folded,
      allIn: !!s.allIn,
    })),
    community: community || [],
    steps,
  };
}

module.exports = {
  getHandReplay,
  buildReplayPayload,
  buildReplayDataFromEngine,
};
