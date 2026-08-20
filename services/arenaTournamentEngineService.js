"use strict";

const crypto = require("crypto");
const ApiError = require("../utils/apiError");
const ArenaTournament = require("../models/arenaTournamentModel");
const Table = require("../models/tableModel");
const Player = require("../models/playerModel");
const {
  withMongoTransaction,
  ledgerWithdraw,
  ledgerDeposit,
} = require("./walletLedgerService");
const tableFactory = require("./tableFactory");
const catalog = require("./arenaTournamentCatalog");
const logger = require("../utils/logger");

const { GAMES, CREATE_FEE, getTier, nextSlotStart, slotKey, houseName, defaultPrizeDistribution } =
  catalog;

function toInt(v) {
  return Math.floor(Number(v) || 0);
}

function normalizeDistribution(dist, playerCount) {
  if (!Array.isArray(dist) || dist.length === 0) return defaultPrizeDistribution(playerCount);
  const cleaned = dist
    .map((d) => ({ place: toInt(d.place), percent: Number(d.percent) || 0 }))
    .filter((d) => d.place >= 1 && d.percent > 0);
  const sum = cleaned.reduce((s, d) => s + d.percent, 0);
  if (!cleaned.length || sum <= 0) return defaultPrizeDistribution(playerCount);
  return cleaned;
}

function makeInviteCode() {
  return crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function tableCapacity(game) {
  return game === "poker" ? 6 : 4;
}

function serializeTournament(t, { viewerId } = {}) {
  const uid = viewerId ? String(viewerId) : null;
  const parts = t.participants || [];
  const registered = uid ? parts.some((p) => String(p.user?._id || p.user) === uid) : false;
  const mine = uid ? parts.find((p) => String(p.user?._id || p.user) === uid) : null;
  return {
    id: String(t._id),
    origin: t.origin,
    game: t.game,
    tierId: t.tierId,
    name: t.name,
    visibility: t.visibility,
    inviteCode: t.visibility === "private" && (registered || String(t.createdBy) === uid)
      ? t.inviteCode
      : undefined,
    type: t.type,
    entryFee: t.entryFee,
    createFee: t.createFee,
    startingChips: t.startingChips,
    prizePool: t.prizePool,
    guaranteedPrize: t.guaranteedPrize,
    prizeDistribution: t.prizeDistribution || [],
    startAt: t.startAt,
    durationMinutes: t.durationMinutes,
    endsAt: t.endsAt,
    maxPlayers: t.maxPlayers,
    minPlayers: t.minPlayers,
    lifecycle: t.lifecycle,
    playerCount: parts.length,
    registered,
    myTableId: mine?.tableId ? String(mine.tableId) : null,
    createdBy: t.createdBy ? String(t.createdBy) : null,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    winners: t.winners || [],
  };
}

function mapInsufficient(err) {
  if (err && err.message === "INSUFFICIENT_BALANCE") {
    throw new ApiError("Insufficient coins", 402);
  }
  throw err;
}

// ─── create (player) ──────────────────────────────────────────────────────────
async function createTournament(actorId, payload = {}) {
  const game = payload.game;
  if (!GAMES.includes(game)) throw new ApiError("Invalid game", 400);

  const visibility = payload.visibility === "private" ? "private" : "public";
  const type = payload.type === "friendly" ? "friendly" : "paid";
  const entryFee = type === "paid" ? Math.max(1, toInt(payload.entryFee)) : 0;
  const durationMinutes = catalog.DURATIONS.includes(toInt(payload.durationMinutes))
    ? toInt(payload.durationMinutes)
    : 4;
  const maxPlayers = Math.min(32, Math.max(4, toInt(payload.maxPlayers) || 8));
  const minPlayers = Math.min(maxPlayers, Math.max(2, toInt(payload.minPlayers) || 4));

  const startAt = payload.startAt
    ? new Date(payload.startAt)
    : new Date(Date.now() + 15 * 60 * 1000);
  if (Number.isNaN(startAt.getTime())) throw new ApiError("Invalid start time", 400);
  if (startAt.getTime() < Date.now() + 60 * 1000) {
    throw new ApiError("Start time must be at least 1 minute from now", 400);
  }
  if (startAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new ApiError("Start time must be within 24 hours", 400);
  }

  const activeMine = await ArenaTournament.countDocuments({
    createdBy: actorId,
    lifecycle: { $in: ["registering", "running"] },
  });
  if (activeMine >= 3) throw new ApiError("You already have 3 active tournaments", 429);

  const name = String(payload.name || `${catalog.GAME_LABEL_AR[game]} · بطولة`)
    .trim()
    .slice(0, 80);
  const startingChips = Math.max(500, toInt(payload.startingChips) || 2000);
  const inviteCode = visibility === "private" ? makeInviteCode() : null;

  let created;
  try {
    created = await withMongoTransaction(async (session) => {
      await ledgerWithdraw({
        session,
        userId: actorId,
        amount: CREATE_FEE,
        ledgerType: "arena_tournament_create",
        meta: { source: "arena_tournament_create", game },
      });
      const docs = await ArenaTournament.create(
        [
          {
            origin: "player",
            createdBy: actorId,
            game,
            tierId: "custom",
            name,
            visibility,
            ...(inviteCode ? { inviteCode } : {}),
            type,
            entryFee,
            createFee: CREATE_FEE,
            startingChips,
            prizePool: 0,
            guaranteedPrize: type === "paid" ? entryFee * maxPlayers : 0,
            prizeDistribution: defaultPrizeDistribution(maxPlayers),
            startAt,
            durationMinutes,
            maxPlayers,
            minPlayers,
            lifecycle: "registering",
          },
        ],
        { session }
      );
      return docs[0];
    });
  } catch (err) {
    mapInsufficient(err);
  }
  return serializeTournament(created, { viewerId: actorId });
}

// ─── register / unregister ────────────────────────────────────────────────────
async function register(userId, tournamentId, { inviteCode } = {}) {
  const t = await ArenaTournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.lifecycle !== "registering") throw new ApiError("Registration is closed", 409);
  if (t.startAt <= new Date()) throw new ApiError("Registration is closed", 409);

  if (t.visibility === "private") {
    const code = String(inviteCode || "").trim().toUpperCase();
    const isCreator = String(t.createdBy) === String(userId);
    if (!isCreator && code !== String(t.inviteCode || "").toUpperCase()) {
      throw new ApiError("Private tournament — invite code required", 403);
    }
  }

  const fee = t.type === "paid" ? toInt(t.entryFee) : 0;
  try {
    await withMongoTransaction(async (session) => {
      if (fee > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: fee,
          ledgerType: "arena_tournament_entry",
          meta: { source: "arena_tournament", tournamentId: String(tournamentId) },
        });
      }
      const inc = fee > 0 ? { escrowHeld: fee, prizePool: fee } : {};
      const update = { $push: { participants: { user: userId, escrow: fee } } };
      if (Object.keys(inc).length) update.$inc = inc;
      const res = await ArenaTournament.updateOne(
        {
          _id: tournamentId,
          lifecycle: "registering",
          "participants.user": { $ne: userId },
          $expr: { $lt: [{ $size: "$participants" }, "$maxPlayers"] },
        },
        update,
        session ? { session } : {}
      );
      if (res.modifiedCount !== 1) {
        throw new ApiError("Cannot register (full, closed, or already registered)", 409);
      }
    });
  } catch (err) {
    mapInsufficient(err);
  }
  return { status: "registered" };
}

async function registerByCode(userId, inviteCode) {
  const code = String(inviteCode || "").trim().toUpperCase();
  if (!code) throw new ApiError("Invite code required", 400);
  const t = await ArenaTournament.findOne({ inviteCode: code, lifecycle: "registering" });
  if (!t) throw new ApiError("Tournament not found", 404);
  return register(userId, t._id, { inviteCode: code });
}

async function unregister(userId, tournamentId) {
  const t = await ArenaTournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.lifecycle !== "registering") throw new ApiError("Cannot unregister after start", 409);
  const part = t.participants.find((p) => String(p.user) === String(userId));
  if (!part) throw new ApiError("You are not registered", 404);

  const refund = toInt(part.escrow);
  await withMongoTransaction(async (session) => {
    const res = await ArenaTournament.updateOne(
      { _id: tournamentId, lifecycle: "registering" },
      {
        $pull: { participants: { user: userId } },
        ...(refund > 0 ? { $inc: { escrowHeld: -refund, prizePool: -refund } } : {}),
      },
      session ? { session } : {}
    );
    if (res.modifiedCount !== 1) throw new ApiError("Cannot unregister", 409);
    if (refund > 0) {
      await ledgerDeposit({
        session,
        userId,
        amount: refund,
        ledgerType: "arena_tournament_refund",
        meta: { source: "arena_tournament_unregister", tournamentId: String(tournamentId) },
      });
    }
  });
  return { status: "unregistered", refunded: refund };
}

// ─── start ────────────────────────────────────────────────────────────────────
async function startTournament(tournamentId) {
  const t = await ArenaTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: "registering" },
    { $set: { lifecycle: "running", startedAt: new Date() } },
    { new: true }
  );
  if (!t) return null;

  if (t.participants.length < t.minPlayers) {
    await cancelTournament(tournamentId, "Not enough players", { system: true });
    return null;
  }

  const cap = tableCapacity(t.game);
  const n = t.participants.length;
  const fullTables = Math.floor(n / cap);
  let seatedCount = fullTables * cap;
  if (t.game === "poker" && seatedCount === 0 && n >= 2) seatedCount = n;
  if (seatedCount < t.minPlayers) {
    await cancelTournament(tournamentId, "Not enough players to fill a table", { system: true });
    return null;
  }

  const overflow = t.participants.slice(seatedCount);
  const seated = t.participants.slice(0, seatedCount);

  for (const p of overflow) {
    const refund = toInt(p.escrow);
    if (refund > 0) {
      try {
        await withMongoTransaction(async (session) => {
          await ledgerDeposit({
            session,
            userId: p.user,
            amount: refund,
            ledgerType: "arena_tournament_refund",
            meta: { source: "arena_tournament_overflow", tournamentId: String(t._id) },
          });
        });
      } catch (err) {
        logger.error("arena_overflow_refund_failed", { reason: err?.message });
      }
    }
  }

  const overflowRefund = overflow.reduce((s, p) => s + toInt(p.escrow), 0);
  const tableIds = [];
  const groups = [];
  if (t.game === "poker" && fullTables === 0) {
    groups.push(seated);
  } else {
    for (let i = 0; i < seatedCount; i += cap) groups.push(seated.slice(i, i + cap));
  }

  for (const group of groups) {
    try {
      const table = await tableFactory.createArenaTournamentTable({
        gameType: t.game,
        tournamentId: t._id,
        capacity: t.game === "poker" ? Math.max(group.length, 2) : cap,
        displayName: t.name,
        allowedUsers: group.map((p) => p.user),
      });
      tableIds.push(table._id);
      for (const p of group) p.tableId = table._id;
    } catch (e) {
      logger.warn("arena_table_create_failed", { reason: e?.message });
    }
  }

  const endsAt = new Date(Date.now() + t.durationMinutes * 60 * 1000);
  const update = {
    $set: {
      participants: seated,
      tableIds,
      endsAt,
      prizeDistribution: normalizeDistribution(t.prizeDistribution, seated.length),
    },
  };
  if (overflowRefund > 0) {
    update.$inc = { escrowHeld: -overflowRefund, prizePool: -overflowRefund };
  }
  await ArenaTournament.updateOne({ _id: t._id }, update);
  return serializeTournament(await ArenaTournament.findById(t._id));
}

// ─── enter / join running table (no wallet) ───────────────────────────────────
async function enter(userId, tournamentId) {
  const t = await ArenaTournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.lifecycle !== "running") throw new ApiError("Tournament is not running", 409);
  const part = t.participants.find((p) => String(p.user) === String(userId));
  if (!part) throw new ApiError("You are not registered", 403);
  if (!part.tableId) throw new ApiError("No table assigned", 409);

  const table = await Table.findById(part.tableId);
  if (!table || table.status === "archived" || table.status === "closed") {
    throw new ApiError("Table is closed", 409);
  }

  const already = (table.seats || []).find((s) => String(s.user) === String(userId));
  if (!already) {
    const player = await Player.getOrCreateByUser(userId);
    const used = new Set((table.seats || []).map((s) => s.seatPosition).filter((n) => n != null));
    let seatPosition = 0;
    while (used.has(seatPosition)) seatPosition += 1;
    if (table.seats.length >= table.capacity) throw new ApiError("Table is full", 409);
    table.seats.push({
      user: userId,
      player: player._id,
      chips: toInt(t.startingChips) || 2000,
      seatPosition,
    });
    await table.save();
  }

  return {
    tableId: String(table._id),
    tableNumber: String(table.tableNumber),
    game: t.game,
    chips: already ? already.chips : toInt(t.startingChips) || 2000,
    endsAt: t.endsAt,
  };
}

/**
 * joinTable hook: arena heats never move wallet coins. Seats the registered
 * player with tournament chips (or reconnects).
 */
async function joinRunningTable({ req, res, next, table }) {
  try {
    const t = await ArenaTournament.findById(table.arenaTournament);
    if (!t || t.lifecycle !== "running") {
      return next(new ApiError("Tournament is not running", 409));
    }
    const userId = req.user._id;
    const part = t.participants.find((p) => String(p.user) === String(userId));
    if (!part) return next(new ApiError("You are not registered in this tournament", 403));

    const already = (table.seats || []).find((s) => String(s.user) === String(userId));
    if (already) {
      return res.status(200).json({
        status: "success",
        message: "Reconnected to existing seat",
        data: {
          tableId: String(table._id),
          tableNumber: table.tableNumber,
          chips: already.chips,
          reconnect: true,
          rtcRoom: { roomId: String(table._id), type: "table" },
        },
      });
    }

    const player = await Player.getOrCreateByUser(userId);
    if ((table.seats || []).length >= table.capacity) {
      return next(new ApiError("Table is full", 400));
    }
    const used = new Set((table.seats || []).map((s) => s.seatPosition).filter((n) => n != null));
    let seatPosition = 0;
    while (used.has(seatPosition)) seatPosition += 1;
    table.seats.push({
      user: userId,
      player: player._id,
      chips: toInt(t.startingChips) || 2000,
      seatPosition,
    });
    await table.save();
    return res.status(200).json({
      status: "success",
      message: "Joined tournament table",
      data: {
        tableId: String(table._id),
        tableNumber: table.tableNumber,
        chips: toInt(t.startingChips) || 2000,
        rtcRoom: { roomId: String(table._id), type: "table" },
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ─── in-heat scoring ──────────────────────────────────────────────────────────
async function onGameFinished({ table, gameType, gameResult, gamePlayers }) {
  try {
    const t = await ArenaTournament.findById(table.arenaTournament);
    if (!t || t.lifecycle !== "running") return { handled: true };

    const seatUser = new Map();
    (Array.isArray(gamePlayers) ? gamePlayers : []).forEach((p, i) => {
      const idx = p.seatIndex != null ? p.seatIndex : i;
      if (p.userId) seatUser.set(idx, String(p.userId));
    });
    (table.seats || []).forEach((s) => {
      if (s.user && s.seatPosition != null && !seatUser.has(s.seatPosition)) {
        seatUser.set(s.seatPosition, String(s.user));
      }
    });

    let { resolveWinnerSeatIndices } = require("./gameSettlementService");
    const seatCount =
      (table.seats && table.seats.length) || (Array.isArray(gamePlayers) ? gamePlayers.length : 4);
    const winnerSeats = resolveWinnerSeatIndices(gameType, gameResult, seatCount);
    const winners = new Set();
    for (const seat of winnerSeats) {
      const u = seatUser.get(seat);
      if (u) winners.add(u);
    }

    for (const p of t.participants) {
      const uid = String(p.user);
      const onTable = [...seatUser.values()].includes(uid);
      if (!onTable) continue;
      p.tournamentScore = toInt(p.tournamentScore) + (winners.has(uid) ? 100 : 10);
      const seat = (table.seats || []).find((s) => String(s.user) === uid);
      if (seat) p.chips = toInt(seat.chips);
    }
    t.gamesCompleted = toInt(t.gamesCompleted) + 1;
    await t.save();
    return { handled: true };
  } catch (e) {
    logger.error("arena_on_game_finished_failed", { reason: e?.message });
    return { handled: true };
  }
}

// ─── finish + payout ──────────────────────────────────────────────────────────
async function finishTournament(tournamentId) {
  const t = await ArenaTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: "running" },
    { $set: { lifecycle: "finished", finishedAt: new Date() } },
    { new: false }
  );
  if (!t) return;
  const previousLifecycle = t.lifecycle;

  if (toInt(t.gamesCompleted) <= 0 && t.type === "paid") {
    await ArenaTournament.updateOne(
      { _id: t._id },
      { $set: { lifecycle: previousLifecycle, finishedAt: null } }
    );
    await cancelTournament(t._id, "No games played", { system: true });
    return;
  }

  const tables = await Table.find({ _id: { $in: t.tableIds || [] } }).lean();
  const chipsByUser = new Map();
  for (const table of tables) {
    for (const s of table.seats || []) {
      chipsByUser.set(String(s.user), toInt(s.chips));
    }
  }
  for (const p of t.participants) {
    const uid = String(p.user);
    if (chipsByUser.has(uid)) p.chips = chipsByUser.get(uid);
  }

  const ranked = [...t.participants].sort((a, b) => {
    const scoreDelta = toInt(b.tournamentScore) - toInt(a.tournamentScore);
    if (scoreDelta !== 0) return scoreDelta;
    return toInt(b.chips) - toInt(a.chips);
  });
  ranked.forEach((p, i) => {
    p.finishPlace = i + 1;
  });

  const prizePool = toInt(t.prizePool);
  const dist = normalizeDistribution(t.prizeDistribution, t.participants.length);
  const byPlace = new Map();
  for (const p of t.participants) if (p.finishPlace != null) byPlace.set(p.finishPlace, String(p.user));

  const payouts = [];
  let allocated = 0;
  if (prizePool > 0) {
    for (const slot of dist) {
      const uid = byPlace.get(slot.place);
      if (!uid) continue;
      const amount = Math.floor((prizePool * slot.percent) / 100);
      if (amount > 0) {
        payouts.push({ userId: uid, place: slot.place, amount });
        allocated += amount;
      }
    }
    const remainder = prizePool - allocated;
    if (remainder > 0) {
      const champ = payouts.find((p) => p.place === 1);
      if (champ) champ.amount += remainder;
      else if (byPlace.get(1)) payouts.push({ userId: byPlace.get(1), place: 1, amount: remainder });
      else if (payouts[0]) payouts[0].amount += remainder;
    }
  }

  const totalPayout = payouts.reduce((s, p) => s + p.amount, 0);

  try {
    await withMongoTransaction(async (session) => {
      if (t.type === "paid" && totalPayout > toInt(t.escrowHeld)) {
        throw new Error(`TOURNAMENT_RECONCILIATION_FAILED:${totalPayout}>${t.escrowHeld}`);
      }
      for (const p of payouts) {
        await ledgerDeposit({
          session,
          userId: p.userId,
          amount: p.amount,
          ledgerType: "arena_tournament_prize",
          meta: { source: "arena_tournament_prize", tournamentId: String(t._id), place: p.place },
        });
      }
      await ArenaTournament.updateOne(
        { _id: t._id },
        {
          $set: {
            prizePaid: totalPayout,
            participants: t.participants,
            winners: payouts.map((p) => ({ userId: p.userId, place: p.place, amount: p.amount })),
          },
        },
        session ? { session } : {}
      );
    });
  } catch (err) {
    await ArenaTournament.updateOne(
      { _id: t._id, prizePaid: 0 },
      { $set: { lifecycle: previousLifecycle, finishedAt: null } }
    ).catch(() => {});
    logger.error("arena_tournament_payout_failed", {
      tournamentId: String(t._id),
      reason: err?.message,
    });
    throw err;
  }

  for (const tid of t.tableIds || []) {
    tableFactory.destroyOrArchiveTable(tid, { reason: "arena_tournament_done" }).catch(() => {});
  }
}

async function cancelTournament(tournamentId, reason = "Cancelled", opts = {}) {
  const existing = await ArenaTournament.findById(tournamentId);
  if (!existing) throw new ApiError("Tournament not found", 404);
  if (existing.lifecycle === "finished" || existing.lifecycle === "cancelled") {
    return { status: existing.lifecycle };
  }
  if (!opts.system) {
    if (!opts.actorId || String(existing.createdBy) !== String(opts.actorId)) {
      throw new ApiError("Not allowed to cancel this tournament", 403);
    }
  }

  const t = await ArenaTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: { $nin: ["finished", "cancelled"] } },
    {
      $set: {
        lifecycle: "cancelled",
        cancelledAt: new Date(),
        cancelReason: reason,
        escrowHeld: 0,
        prizePool: 0,
      },
    },
    { new: false }
  );
  if (!t) {
    const now = await ArenaTournament.findById(tournamentId).select("lifecycle").lean();
    return { status: now?.lifecycle || "cancelled" };
  }

  try {
    await withMongoTransaction(async (session) => {
      for (const p of t.participants) {
        const refund = toInt(p.escrow);
        if (refund > 0) {
          await ledgerDeposit({
            session,
            userId: p.user,
            amount: refund,
            ledgerType: "arena_tournament_refund",
            meta: { source: "arena_tournament_cancel", tournamentId: String(t._id) },
          });
        }
      }
    });
  } catch (err) {
    await ArenaTournament.updateOne(
      { _id: t._id },
      {
        $set: {
          lifecycle: t.lifecycle,
          cancelledAt: null,
          cancelReason: null,
          escrowHeld: t.escrowHeld,
          prizePool: t.prizePool,
        },
      }
    ).catch(() => {});
    logger.error("arena_tournament_refund_failed", {
      tournamentId: String(t._id),
      reason: err?.message,
    });
    throw err;
  }

  for (const tid of t.tableIds || []) {
    tableFactory.destroyOrArchiveTable(tid, { reason: "arena_tournament_cancel" }).catch(() => {});
  }
  return { status: "cancelled" };
}

// ─── house schedule ───────────────────────────────────────────────────────────
async function ensureSchedule(nowMs = Date.now()) {
  const slot = nextSlotStart(nowMs);
  const slots = [slot, slot + catalog.SLOT_MS];
  for (const startMs of slots) {
    for (const game of GAMES) {
      for (const tier of catalog.TIERS) {
        const key = slotKey(game, tier.id, startMs);
        try {
          await ArenaTournament.updateOne(
            { slotKey: key },
            {
              $setOnInsert: {
                origin: "house",
                game,
                tierId: tier.id,
                name: houseName(game, tier),
                visibility: "public",
                type: "paid",
                entryFee: tier.entryFee,
                createFee: 0,
                startingChips: tier.startingChips,
                prizePool: 0,
                guaranteedPrize: tier.guaranteedPrize,
                prizeDistribution: defaultPrizeDistribution(tier.maxPlayers),
                startAt: new Date(startMs),
                durationMinutes: tier.durationMinutes,
                maxPlayers: tier.maxPlayers,
                minPlayers: tier.minPlayers,
                lifecycle: "registering",
                slotKey: key,
              },
            },
            { upsert: true }
          );
        } catch (err) {
          if (err?.code !== 11000) {
            logger.warn("arena_schedule_upsert_failed", { key, reason: err?.message });
          }
        }
      }
    }
  }
}

async function tick() {
  const now = new Date();
  try {
    await ensureSchedule(now.getTime());
  } catch (e) {
    logger.warn("arena_schedule_failed", { reason: e?.message });
  }

  const toStart = await ArenaTournament.find({ lifecycle: "registering", startAt: { $lte: now } })
    .select("_id")
    .limit(40)
    .lean();
  for (const row of toStart) {
    try {
      await startTournament(row._id);
    } catch (e) {
      logger.warn("arena_tournament_start_failed", { id: String(row._id), reason: e?.message });
    }
  }

  const toFinish = await ArenaTournament.find({ lifecycle: "running", endsAt: { $lte: now } })
    .select("_id")
    .limit(40)
    .lean();
  for (const row of toFinish) {
    try {
      await finishTournament(row._id);
    } catch (e) {
      logger.warn("arena_tournament_finish_failed", { id: String(row._id), reason: e?.message });
    }
  }
}

let _timer = null;
function startEngine({ intervalMs = 20000 } = {}) {
  if (_timer) return _timer;
  tick().catch((e) => logger.warn("arena_tournament_boot_tick_failed", { reason: e?.message }));
  _timer = setInterval(() => {
    tick().catch((e) => logger.warn("arena_tournament_tick_failed", { reason: e?.message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  return _timer;
}
function stopEngine() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

// ─── reads ────────────────────────────────────────────────────────────────────
async function listLobby(viewerId, { game, includePrivate = true } = {}) {
  await ensureSchedule().catch(() => {});
  const now = new Date();
  const filter = {
    lifecycle: { $in: ["registering", "running"] },
    $or: [
      { visibility: "public" },
      ...(viewerId
        ? [{ createdBy: viewerId }, { "participants.user": viewerId }]
        : []),
    ],
  };
  if (game && GAMES.includes(game)) filter.game = game;
  const rows = await ArenaTournament.find(filter).sort({ startAt: 1 }).limit(80);
  const live = rows.filter((t) => t.lifecycle === "running" || t.startAt > now || t.lifecycle === "registering");
  return live.map((t) => serializeTournament(t, { viewerId }));
}

async function getDetail(tournamentId, viewerId) {
  const t = await ArenaTournament.findById(tournamentId).populate(
    "participants.user",
    "name profileImg"
  );
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.visibility === "private") {
    const uid = viewerId ? String(viewerId) : "";
    const allowed =
      String(t.createdBy) === uid ||
      t.participants.some((p) => String(p.user?._id || p.user) === uid);
    if (!allowed) throw new ApiError("Tournament not found", 404);
  }
  return {
    ...serializeTournament(t, { viewerId }),
    participants: t.participants.map((p) => ({
      userId: String(p.user?._id || p.user),
      name: p.user?.name || null,
      avatar: p.user?.profileImg || null,
      score: p.tournamentScore,
      chips: p.chips,
      finishPlace: p.finishPlace,
      tableId: p.tableId ? String(p.tableId) : null,
    })),
  };
}

module.exports = {
  createTournament,
  register,
  registerByCode,
  unregister,
  enter,
  joinRunningTable,
  startTournament,
  finishTournament,
  cancelTournament,
  onGameFinished,
  ensureSchedule,
  tick,
  startEngine,
  stopEngine,
  listLobby,
  getDetail,
  serializeTournament,
};
