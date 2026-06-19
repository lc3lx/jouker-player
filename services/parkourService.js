const crypto = require("crypto");
const ParkourRace = require("../models/parkourRaceModel");
const ParkourCheckpoint = require("../models/parkourCheckpointModel");
const ParkourResult = require("../models/parkourResultModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const { withMongoTransaction, transferToLocked } = require("./walletLedgerService");
const { settleParkourRace, recoverPendingSettlement } = require("./gameSettlementService");
const parkourRoomManager = require("../games/parkour/parkourRoomManager");
const ParkourGame = require("../games/parkour/ParkourGame");
const { ParkourRoom } = require("../games/parkour/ParkourRoom");

const DEFAULT_TRACK_ID = "default-city";

function generateRaceId() {
  return `pk_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function ensureDefaultTrack() {
  const existing = await ParkourCheckpoint.findOne({ trackId: DEFAULT_TRACK_ID });
  if (existing) return existing;

  const checkpoints = Array.from({ length: 8 }, (_, i) => ({
    index: i,
    x: 0,
    y: 0,
    z: (i + 1) * 12,
    radius: 3.5,
  }));

  return ParkourCheckpoint.create({
    trackId: DEFAULT_TRACK_ID,
    name: "City Sprint",
    nameEn: "City Sprint",
    description: "Default parkour track — 8 checkpoints",
    checkpoints,
    finishLine: { x: 0, y: 0, z: 110, radius: 5 },
    spawnPoint: { x: 0, y: 0, z: 0 },
    maxPlayers: 20,
    isActive: true,
  });
}

async function getTracks(req, res) {
  await ensureDefaultTrack();
  const tracks = await ParkourCheckpoint.find({ isActive: true })
    .select("trackId name nameEn description maxPlayers checkpoints finishLine spawnPoint")
    .lean();
  res.status(200).json({ status: "success", results: tracks.length, data: tracks });
}

async function getRace(req, res) {
  const { raceId } = req.params;
  const race = await ParkourRace.findOne({ raceId }).lean();
  if (!race) throw new ApiError("Race not found", 404);
  res.status(200).json({ status: "success", data: race });
}

async function createRace({ trackId, entryFee, minPlayers, maxPlayers, hostUserId }) {
  await ensureDefaultTrack();
  const tid = trackId || DEFAULT_TRACK_ID;
  const track = await ParkourCheckpoint.findOne({ trackId: tid, isActive: true });
  if (!track) throw new ApiError("Track not found", 404);

  const fee = Math.max(0, Math.floor(Number(entryFee) || 0));
  const minP = Math.max(2, Math.min(20, Number(minPlayers) || 2));
  const maxP = Math.max(minP, Math.min(20, Number(maxPlayers) || track.maxPlayers || 20));

  const raceId = generateRaceId();
  const raceDoc = await ParkourRace.create({
    raceId,
    trackId: tid,
    state: "waiting",
    entryFee: fee,
    minPlayers: minP,
    maxPlayers: maxP,
    participants: [],
    sessionId: crypto.randomUUID(),
  });

  const game = new ParkourGame(raceDoc.toObject(), track.toObject());
  const room = new ParkourRoom(game);
  parkourRoomManager.registerRoom(raceId, room);

  logger.info("parkour_race_created", { raceId, trackId: tid, entryFee: fee });
  return { raceId, race: raceDoc, room };
}

async function createRaceHandler(req, res) {
  const { trackId, entryFee, minPlayers, maxPlayers } = req.body || {};
  const { raceId, race } = await createRace({
    trackId,
    entryFee,
    minPlayers,
    maxPlayers,
    hostUserId: req.user?._id,
  });
  res.status(201).json({
    status: "success",
    data: { raceId, trackId: race.trackId, entryFee: race.entryFee, state: race.state },
  });
}

async function joinRace({ raceId, userId, displayName, socketId }) {
  const race = await ParkourRace.findOne({ raceId });
  if (!race) throw new ApiError("Race not found", 404);
  if (race.state !== "waiting") throw new ApiError("Race already started", 400);
  if (race.participants.length >= race.maxPlayers) throw new ApiError("Race is full", 400);

  const already = race.participants.find((p) => String(p.userId) === String(userId));
  if (already) {
    return { raceId, seatIndex: already.seatIndex, alreadyJoined: true };
  }

  const fee = race.entryFee;
  if (fee > 0) {
    let wallet = await Wallet.findOne({ user: userId });
    if (!wallet) wallet = await Wallet.create({ user: userId });
    if (!wallet.hasSufficientAvailable(fee)) {
      throw new ApiError("Insufficient wallet balance", 400);
    }
  }

  const user = await User.findById(userId).select("name username").lean();
  const name = displayName || user?.name || user?.username || `Player`;

  let seatIndex;
  await withMongoTransaction(async (session) => {
    const raceTx = await ParkourRace.findOne({ raceId, state: "waiting" }).session(session);
    if (!raceTx) throw new Error("RACE_NOT_FOUND");
    if (raceTx.participants.length >= raceTx.maxPlayers) throw new Error("RACE_FULL");
    const dup = raceTx.participants.find((p) => String(p.userId) === String(userId));
    if (dup) throw new Error("ALREADY_JOINED");

    if (fee > 0) {
      await transferToLocked({
        session,
        userId,
        amount: fee,
        tableId: raceTx._id,
        meta: { reason: "parkour_entry_fee", raceId },
      });
    }

    seatIndex = raceTx.participants.length;
    raceTx.participants.push({
      userId,
      seatIndex,
      displayName: name,
      buyIn: fee,
      ready: false,
      status: "active",
      lastCheckpoint: -1,
      checkpointsReached: [],
      socketId: socketId || null,
      lastPosition: { x: 0, y: 0, z: 0, t: Date.now() },
    });
    await raceTx.save({ session });
  }).catch((e) => {
    if (e.message === "INSUFFICIENT_BALANCE") throw new ApiError("Insufficient wallet balance", 400);
    if (e.message === "RACE_FULL") throw new ApiError("Race is full", 400);
    if (e.message === "ALREADY_JOINED") return { raceId, alreadyJoined: true };
    if (e.message === "RACE_NOT_FOUND") throw new ApiError("Race not found", 404);
    throw e;
  });

  let room = parkourRoomManager.getRoom(raceId);
  if (!room) {
    room = await parkourRoomManager.loadRoom(raceId);
  }
  if (room) {
    const existing = room.game.getPlayer(userId);
    if (!existing) {
      room.game.addPlayer({ userId, displayName: name, buyIn: fee, socketId });
    } else if (socketId) {
      existing.socketId = socketId;
    }
    await room.persist();
    parkourRoomManager.bindUser(userId, raceId, socketId);
  }

  return { raceId, seatIndex, buyIn: fee };
}

async function joinRaceHandler(req, res) {
  const { raceId } = req.params;
  const result = await joinRace({
    raceId,
    userId: req.user._id,
    displayName: req.body?.displayName,
  });
  res.status(200).json({ status: "success", data: result });
}

async function persistRaceResults(race, settlement) {
  const planByUser = new Map();
  for (const p of settlement?.plan?.participants || settlement?.participants || []) {
    if (p.userId) planByUser.set(String(p.userId), p);
  }

  const ops = [];
  for (const p of race.game.players) {
    const plan = planByUser.get(String(p.userId));
    ops.push(
      ParkourResult.findOneAndUpdate(
        { raceId: race.game.raceId, userId: p.userId },
        {
          raceMongoId: race.game.mongoId,
          trackId: race.game.trackId,
          finishOrder: p.finishOrder,
          finishTimeMs: p.finishTimeMs,
          checkpointsReached: p.checkpointsReached?.length || 0,
          entryFee: p.buyIn,
          payout: plan?.payout || 0,
          netDelta: plan?.netDelta || -p.buyIn,
          forfeited: p.status === "forfeited",
          won: !!(plan?.isWinner && plan?.payout > 0),
          settlementId: settlement?.settlement?.settlementId,
        },
        { upsert: true, new: true }
      )
    );
  }
  await Promise.all(ops);
}

async function runParkourSettlement(room) {
  const game = room.game;
  if (game.state === "settled" || game.state === "settlement_pending") {
    return { duplicate: true };
  }

  game.transition("settlement_pending");
  await room.persist({ settlementStatus: "pending" });

  const gameResult = game.getGameResult();
  try {
    const outcome = await settleParkourRace({
      raceMongoId: game.mongoId,
      sessionId: game.sessionId,
      gameResult,
      gamePlayers: game.players,
    });

    game.transition("settled");
    await room.persist({ settlementStatus: "completed", state: "settled" });
    await persistRaceResults(room, outcome);

    return outcome;
  } catch (err) {
    logger.error("parkour_settlement_error", { raceId: game.raceId, reason: err?.message });
    throw err;
  }
}

async function getLeaderboard(req, res) {
  const { trackId, sort = "fastest", limit = 50 } = req.query;
  const cap = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

  if (sort === "wins") {
    const pipeline = [
      { $match: { won: true, ...(trackId ? { trackId } : {}) } },
      { $group: { _id: "$userId", wins: { $sum: 1 }, bestTime: { $min: "$finishTimeMs" } } },
      { $sort: { wins: -1, bestTime: 1 } },
      { $limit: cap },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
    ];
    const rows = await ParkourResult.aggregate(pipeline);
    return res.status(200).json({
      status: "success",
      sort: "wins",
      results: rows.length,
      data: rows.map((r) => ({
        userId: r._id,
        displayName: r.user?.name || r.user?.username || "Player",
        wins: r.wins,
        bestTimeMs: r.bestTime,
      })),
    });
  }

  if (sort === "races") {
    const pipeline = [
      { $match: trackId ? { trackId } : {} },
      { $group: { _id: "$userId", racesPlayed: { $sum: 1 }, wins: { $sum: { $cond: ["$won", 1, 0] } } } },
      { $sort: { racesPlayed: -1 } },
      { $limit: cap },
    ];
    const rows = await ParkourResult.aggregate(pipeline);
    return res.status(200).json({
      status: "success",
      sort: "races",
      results: rows.length,
      data: rows.map((r) => ({ userId: r._id, racesPlayed: r.racesPlayed, wins: r.wins })),
    });
  }

  const q = { finishTimeMs: { $ne: null, $gt: 0 }, forfeited: false };
  if (trackId) q.trackId = trackId;

  const rows = await ParkourResult.find(q)
    .sort({ finishTimeMs: 1 })
    .limit(cap)
    .populate("userId", "name username")
    .lean();

  res.status(200).json({
    status: "success",
    sort: "fastest",
    results: rows.length,
    data: rows.map((r) => ({
      userId: r.userId?._id || r.userId,
      displayName: r.userId?.name || r.userId?.username || "Player",
      finishTimeMs: r.finishTimeMs,
      trackId: r.trackId,
      raceId: r.raceId,
      finishOrder: r.finishOrder,
    })),
  });
}

async function recoverParkourSettlements() {
  const pending = await ParkourRace.find({
    settlementStatus: "pending",
    state: { $in: ["finished", "settlement_pending"] },
  }).lean();

  let recovered = 0;
  for (const race of pending) {
    if (!race.activeSettlementId) continue;
    try {
      await recoverPendingSettlement(race.activeSettlementId);
      await ParkourRace.findByIdAndUpdate(race._id, {
        $set: { state: "settled", settlementStatus: "completed" },
      });
      recovered += 1;
    } catch (err) {
      logger.error("parkour_settlement_recovery_failed", {
        raceId: race.raceId,
        reason: err?.message,
      });
    }
  }
  return recovered;
}

module.exports = {
  DEFAULT_TRACK_ID,
  ensureDefaultTrack,
  generateRaceId,
  createRace,
  createRaceHandler,
  joinRace,
  joinRaceHandler,
  getTracks,
  getRace,
  getLeaderboard,
  runParkourSettlement,
  persistRaceResults,
  recoverParkourSettlements,
};
