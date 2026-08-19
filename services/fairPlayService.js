const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const HandHistory = require("../models/handHistoryModel");
const Table = require("../models/tableModel");
const PokerHandCommit = require("../models/pokerHandCommitModel");
const { verifyRecordedPokerHand } = require("../utils/poker/fairnessVerifier");
const { newDeck, shuffleDeterministic } = require("../utils/poker/deck");
const { buildDeckCommitment } = require("../utils/poker/fairnessCommitment");

// #region agent log
function _agentDbg(hypothesisId, location, message, data = {}) {
  try {
    fs.appendFileSync(
      path.join(__dirname, "..", "..", "debug-b181d7.log"),
      `${JSON.stringify({
        sessionId: "b181d7",
        hypothesisId,
        location,
        message,
        data,
        timestamp: Date.now(),
      })}\n`
    );
  } catch (_) {}
}
// #endregion

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function userIdOf(value) {
  if (value == null) return "";
  if (typeof value === "object") return String(value._id || value.id || value.user || "");
  return String(value);
}

/**
 * Player-facing last-hand review. Cards and winners only — no seed / JSON proofs.
 */
function buildFairPlayView(hand, viewerUserId) {
  const uid = String(viewerUserId || "");
  const seats = Array.isArray(hand?.seats) ? hand.seats : [];
  const winnerShareByUser = new Map();
  for (const row of hand?.winners || []) {
    const id = userIdOf(row?.user);
    if (!id) continue;
    winnerShareByUser.set(id, toSafeInt(row.share ?? row.amountWon, 0));
  }

  const players = seats.map((seat, index) => {
    const id = userIdOf(seat?.user);
    const isBot = seat?.isBot === true || !id;
    const isMe = !!id && id === uid;
    const populatedName = seat?.user && typeof seat.user === "object"
      ? seat.user.name
      : null;
    const name =
      (typeof seat?.name === "string" && seat.name.trim()) ||
      (typeof populatedName === "string" && populatedName.trim()) ||
      (isBot ? `بوت ${index + 1}` : "لاعب");
    const chipsBefore = toSafeInt(seat?.chipsBefore, 0);
    const chipsAfter = toSafeInt(seat?.chipsAfter, 0);
    const net = seat?.net != null ? toSafeInt(seat.net, 0) : chipsAfter - chipsBefore;
    const folded = seat?.folded === true || seat?.result === "folded";
    const won =
      seat?.won === true ||
      seat?.result === "won" ||
      winnerShareByUser.has(id) ||
      net > 0;
    const hole = Array.isArray(seat?.hole)
      ? seat.hole.filter((c) => typeof c === "string" && c.trim())
      : [];
    const share = winnerShareByUser.has(id)
      ? winnerShareByUser.get(id)
      : (won && net > 0 ? net : 0);

    return {
      number: index + 1,
      name: String(name),
      isMe,
      isBot,
      folded,
      won,
      net,
      share,
      hole,
      handCategory: seat?.handCategory || null,
    };
  });

  const winners = players
    .filter((p) => p.won)
    .map((p) => ({
      number: p.number,
      name: p.name,
      isMe: p.isMe,
      isBot: p.isBot,
      share: p.share > 0 ? p.share : p.net,
    }));

  return {
    handId: hand?.handId || null,
    pot: toSafeInt(hand?.pot, 0),
    handCategory: hand?.handCategory || null,
    community: Array.isArray(hand?.community) ? hand.community.filter(Boolean) : [],
    endedAt: hand?.endedAt || null,
    winners,
    players,
  };
}

async function verifyHandFairness(hand, tableId) {
  const replay = verifyRecordedPokerHand(hand);
  const commit = await PokerHandCommit.findOne({ handId: hand.handId })
    .select("handId table serverSeedHash clientSeedDigest deckCommitmentRoot issuedAt")
    .lean();
  const commitMatches = !!commit &&
    String(commit.table) === String(tableId) &&
    commit.serverSeedHash === hand.provablyFair?.serverSeedHash &&
    commit.clientSeedDigest === hand.provablyFair?.clientSeedDigest &&
    commit.deckCommitmentRoot === hand.provablyFair?.deckCommitmentRoot &&
    new Date(commit.issuedAt).getTime() <= new Date(hand.endedAt).getTime();

  let deckCommitmentValid = false;
  if (replay.valid && hand.provablyFair?.serverSeed && hand.provablyFair?.handId) {
    const deck = shuffleDeterministic(
      newDeck(),
      `${hand.provablyFair.serverSeed}:${hand.provablyFair.clientSeedDigest}:${hand.provablyFair.handId}`
    );
    const drawOrder = [...deck].reverse();
    const root = buildDeckCommitment(hand.handId, drawOrder).root;
    deckCommitmentValid = root === hand.provablyFair.deckCommitmentRoot;
  }

  return {
    verified: !!(replay.valid && commitMatches && deckCommitmentValid),
  };
}

exports.buildFairPlayView = buildFairPlayView;

const HAND_VIEW_SELECT =
  "handId table community pot winners handCategory endedAt seats";

function populateHandView(query) {
  return query
    .select(HAND_VIEW_SELECT)
    .populate("winners.user", "name")
    .populate("seats.user", "name");
}

async function assertFairPlayAccess(tableId, viewerId) {
  const table = await Table.findById(tableId).select("_id seats");
  if (!table) return { error: new ApiError("Table not found", 404) };
  const seatedNow = (table.seats || []).some(
    (s) => String(s.user) === String(viewerId)
  );
  if (seatedNow) return { table, seatedNow: true };
  const participated = await HandHistory.exists({
    table: tableId,
    $or: [{ "players.user": viewerId }, { "seats.user": viewerId }],
  });
  if (!participated) {
    return { error: new ApiError("Not authorized to view this table history", 403) };
  }
  return { table, seatedNow: false };
}

function emptyFairPlayPayload() {
  return {
    handId: null,
    pot: 0,
    community: [],
    winners: [],
    players: [],
    verified: false,
    empty: true,
  };
}

exports.getFairPlayLastHand = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const viewerId = req.user._id;
  const access = await assertFairPlayAccess(tableId, viewerId);
  if (access.error) return next(access.error);

  const hand = await HandHistory.findOne({ table: tableId, gameType: "poker" })
    .sort({ endedAt: -1, createdAt: -1 })
    .select(`${HAND_VIEW_SELECT} provablyFair`)
    .populate("winners.user", "name")
    .populate("seats.user", "name")
    .lean();

  if (!hand) {
    return res.status(200).json({
      status: "success",
      data: emptyFairPlayPayload(),
    });
  }

  const view = buildFairPlayView(hand, viewerId);
  let verified = false;
  try {
    const fairness = await verifyHandFairness(hand, tableId);
    verified = fairness.verified === true;
  } catch (_) {
    verified = false;
  }

  res.status(200).json({
    status: "success",
    data: {
      ...view,
      verified,
      empty: false,
    },
  });
});

exports.getFairPlayHands = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const viewerId = req.user._id;
  const access = await assertFairPlayAccess(tableId, viewerId);
  if (access.error) return next(access.error);

  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "100", 10) || 100));
  const skip = (page - 1) * limit;
  const filter = { table: tableId, gameType: "poker" };

  const [total, docs] = await Promise.all([
    HandHistory.countDocuments(filter),
    populateHandView(
      HandHistory.find(filter).sort({ endedAt: -1, createdAt: -1 }).skip(skip).limit(limit)
    ).lean(),
  ]);

  const hands = docs.map((hand, i) => ({
    ...buildFairPlayView(hand, viewerId),
    number: total - skip - i,
    empty: false,
  }));

  // #region agent log
  _agentDbg("M", "fairPlayService.js:getFairPlayHands", "list table hands", {
    tableId: String(tableId),
    seatedNow: access.seatedNow === true,
    total,
    returned: hands.length,
    page,
    limit,
    firstHandId: hands[0]?.handId || null,
    lastHandId: hands[hands.length - 1]?.handId || null,
  });
  // #endregion

  res.status(200).json({
    status: "success",
    data: { total, page, limit, hands },
  });
});

exports.adminSearchHands = asyncHandler(async (req, res) => {
  const handId = String(req.query.handId || "").trim();
  const tableId = String(req.query.tableId || "").trim();
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10) || 20));
  const skip = (page - 1) * limit;

  const filter = { gameType: "poker" };
  if (handId) filter.handId = handId;
  if (tableId && mongoose.isValidObjectId(tableId)) filter.table = tableId;

  const [total, docs] = await Promise.all([
    HandHistory.countDocuments(filter),
    populateHandView(
      HandHistory.find(filter).sort({ endedAt: -1, createdAt: -1 }).skip(skip).limit(limit)
    ).lean(),
  ]);

  const data = docs.map((hand, i) => ({
    ...buildFairPlayView(hand, null),
    number: total - skip - i,
    tableId: String(hand.table || ""),
  }));

  // #region agent log
  _agentDbg("N", "fairPlayService.js:adminSearchHands", "admin hands search", {
    hasHandId: !!handId,
    hasTableId: !!tableId,
    total,
    returned: data.length,
  });
  // #endregion

  res.status(200).json({ total, page, limit, data });
});

exports.adminGetHandById = asyncHandler(async (req, res) => {
  const handId = String(req.params.handId || "").trim();
  const hand = await populateHandView(HandHistory.findOne({ handId })).lean();
  if (!hand) {
    return res.status(404).json({ message: "اليد غير موجودة" });
  }

  // #region agent log
  _agentDbg("N", "fairPlayService.js:adminGetHandById", "admin hand lookup", {
    found: true,
    playerCount: Array.isArray(hand.seats) ? hand.seats.length : 0,
  });
  // #endregion

  res.status(200).json({
    data: {
      ...buildFairPlayView(hand, null),
      tableId: String(hand.table || ""),
    },
  });
});
