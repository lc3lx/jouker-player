const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanTournament = require("../models/clanTournamentModel");
const ClanTournamentMatch = require("../models/clanTournamentMatchModel");
const {
  withMongoTransaction,
  ledgerWithdraw,
  ledgerDeposit,
} = require("./walletLedgerService");
const tableFactory = require("./tableFactory");
const clanService = require("./clanService");
const clanPermissionService = require("./clanPermissionService");
const clanTreasuryService = require("./clanTreasuryService");
const clanMembershipService = require("./clanMembershipService");
const chatService = require("./chatService");
const clanRealtime = require("./clanRealtime");
const logger = require("../utils/logger");

const GAMES = ["poker", "trix", "tarneeb41"];
const GAME_WIN_STAT = { poker: "pokerWins", trix: "trixWins", tarneeb41: "tarneebWins" };
const MATCH_DEADLINE_MS = 15 * 60 * 1000; // 15 min to play a match before walkover

// ─── helpers ──────────────────────────────────────────────────────────────────
function toInt(v) {
  return Math.floor(Number(v) || 0);
}
function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Top-heavy default payout split (percent) sized to the field. */
function defaultPrizeDistribution(playerCount) {
  if (playerCount <= 2) return [{ place: 1, percent: 100 }];
  if (playerCount <= 4) return [{ place: 1, percent: 70 }, { place: 2, percent: 30 }];
  if (playerCount <= 8) {
    return [
      { place: 1, percent: 60 },
      { place: 2, percent: 25 },
      { place: 3, percent: 15 },
    ];
  }
  return [
    { place: 1, percent: 50 },
    { place: 2, percent: 25 },
    { place: 3, percent: 15 },
    { place: 4, percent: 10 },
  ];
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

// ─── create ─────────────────────────────────────────────────────────────────
async function createTournament(actorId, clanId, payload = {}) {
  const clan = await Clan.findById(clanId);
  if (!clan || clan.status !== "active") throw new ApiError("Clan not available", 404);
  const actor = await ClanMember.findOne({ clan: clanId, user: actorId }).lean();
  if (!actor) throw new ApiError("You are not a member of this clan", 403);
  const settings = await clanService.getSettings();
  clanPermissionService.assertCan(clan, actor.role, "createTournaments", settings);

  const game = payload.game;
  if (!GAMES.includes(game)) throw new ApiError("Invalid game", 400);
  const type = payload.type === "paid" ? "paid" : "friendly";
  const entryFee = type === "paid" ? Math.max(1, toInt(payload.entryFee)) : 0;
  const maxPlayers = Math.min(64, Math.max(2, toInt(payload.maxPlayers) || 8));
  const minPlayers = Math.min(maxPlayers, Math.max(2, toInt(payload.minPlayers) || 2));
  const startAt = payload.startAt ? new Date(payload.startAt) : new Date(Date.now() + 10 * 60 * 1000);
  if (Number.isNaN(startAt.getTime())) throw new ApiError("Invalid start time", 400);

  // Concurrency cap per clan.
  const activeCount = await ClanTournament.countDocuments({
    clan: clanId,
    lifecycle: { $in: ["registering", "seeding", "running"] },
  });
  if (settings.maxTournamentsPerClan > 0 && activeCount >= settings.maxTournamentsPerClan) {
    throw new ApiError("This clan has reached its active tournament limit", 429);
  }

  const manualPrizePool = type === "friendly" ? Math.max(0, toInt(payload.manualPrizePool)) : 0;
  const t = await ClanTournament.create({
    clan: clanId,
    createdBy: actorId,
    game,
    name: String(payload.name || "Clan Tournament").trim().slice(0, 60),
    description: String(payload.description || "").slice(0, 500),
    type,
    entryFee,
    manualPrizePool,
    prizePool: manualPrizePool, // grows with entries for paid
    prizeDistribution: normalizeDistribution(payload.prizeDistribution, maxPlayers),
    startAt,
    maxPlayers,
    minPlayers,
    format: payload.format === "round_robin" ? "round_robin" : "single_elim",
    lifecycle: "registering",
  });

  clanRealtime.emitToClan(clanId, "clan:tournament_update", {
    type: "created",
    tournamentId: String(t._id),
    name: t.name,
    game,
  });
  chatService
    .sendSystemMessage({
      channel: "clan",
      channelId: clanId,
      actorId,
      body: `تم إنشاء بطولة: ${t.name}`,
      meta: { event: "tournament_created", tournamentId: String(t._id) },
    })
    .catch(() => {});
  return serializeTournament(t);
}

// ─── register / unregister ────────────────────────────────────────────────────
async function register(userId, tournamentId) {
  const t = await ClanTournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.lifecycle !== "registering") throw new ApiError("Registration is closed", 409);
  if (t.startAt <= new Date()) throw new ApiError("Registration is closed", 409);

  const member = await ClanMember.findOne({ clan: t.clan, user: userId }).lean();
  if (!member) throw new ApiError("Only clan members can join this tournament", 403);

  const fee = t.type === "paid" ? t.entryFee : 0;
  try {
    await withMongoTransaction(async (session) => {
      if (fee > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: fee,
          ledgerType: "clan_tournament_entry",
          meta: { source: "clan_tournament", tournamentId: String(tournamentId) },
        });
      }
      const inc = fee > 0 ? { escrowHeld: fee, prizePool: fee } : {};
      const update = { $push: { participants: { user: userId, escrow: fee } } };
      if (Object.keys(inc).length) update.$inc = inc;
      const res = await ClanTournament.updateOne(
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
        // Aborts the txn → any fee withdrawal rolls back.
        throw new ApiError("Cannot register (full, closed, or already registered)", 409);
      }
    });
  } catch (err) {
    if (err && err.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("Insufficient coins for entry fee", 402);
    }
    throw err;
  }
  clanRealtime.emitToClan(t.clan, "clan:tournament_update", {
    type: "registered",
    tournamentId: String(tournamentId),
    userId: String(userId),
  });
  return { status: "registered" };
}

async function unregister(userId, tournamentId) {
  const t = await ClanTournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (t.lifecycle !== "registering") throw new ApiError("Cannot unregister after start", 409);
  const part = t.participants.find((p) => String(p.user) === String(userId));
  if (!part) throw new ApiError("You are not registered", 404);

  const refund = toInt(part.escrow);
  await withMongoTransaction(async (session) => {
    const res = await ClanTournament.updateOne(
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
        ledgerType: "clan_tournament_refund",
        meta: { source: "clan_tournament_unregister", tournamentId: String(tournamentId) },
      });
    }
  });
  return { status: "unregistered", refunded: refund };
}

// ─── start + bracket ──────────────────────────────────────────────────────────
async function startTournament(tournamentId) {
  /**
   * Atomically CLAIM the start by flipping registering → seeding. The post-image
   * is the authoritative roster: `unregister` only matches while the tournament
   * is still "registering", so once we hold the claim the participant list and
   * escrow can no longer drift underneath us.
   *
   * The previous read-then-`save()` allowed a concurrent unregister to be undone
   * by the stale in-memory participants array — refunding a player who stayed in
   * the bracket, and leaving escrowHeld out of step with the seated roster.
   */
  const t = await ClanTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: "registering" },
    { $set: { lifecycle: "seeding", startedAt: new Date() } },
    { new: true }
  );
  if (!t) return null;

  if (t.participants.length < t.minPlayers) {
    await cancelTournament(null, tournamentId, "Not enough players", { system: true });
    return null;
  }

  // Seed by registration order (participant index = seed).
  t.participants.forEach((p, i) => {
    p.seed = i;
  });
  const n = t.participants.length;
  const bracketSize = nextPowerOfTwo(n);
  const rounds = Math.log2(bracketSize);
  t.rounds = rounds;
  t.currentRound = 1;
  // Targeted write of the claimed snapshot — safe now that registration is closed.
  await ClanTournament.updateOne(
    { _id: t._id },
    { $set: { participants: t.participants, rounds, currentRound: 1 } }
  );

  // Round-1 pairing: seed i vs seed (bracketSize-1-i) → byes fall on top seeds.
  const seeds = t.participants.map((p) => String(p.user));
  const half = bracketSize / 2;
  for (let i = 0; i < half; i++) {
    const a = seeds[i] || null;
    const b = seeds[bracketSize - 1 - i] || null;
    const players = [a, b].filter(Boolean);
    const match = await ClanTournamentMatch.create({
      tournament: t._id,
      clan: t.clan,
      round: 1,
      matchIndex: i,
      players,
      nextMatchIndex: Math.floor(i / 2),
      status: "pending",
    });
    if (players.length === 1) {
      // Bye — auto-advance immediately.
      await resolveMatch(match, players[0], { walkover: true });
    } else if (players.length === 2) {
      await launchMatch(match._id);
    }
  }

  await ClanTournament.updateOne({ _id: t._id }, { $set: { lifecycle: "running" } });
  clanRealtime.emitToClan(t.clan, "clan:tournament_update", {
    type: "started",
    tournamentId: String(t._id),
  });
  chatService
    .sendSystemMessage({
      channel: "clan",
      channelId: t.clan,
      actorId: t.createdBy,
      body: `انطلقت بطولة: ${t.name}`,
      meta: { event: "tournament_started", tournamentId: String(t._id) },
    })
    .catch(() => {});
  return serializeTournament(await ClanTournament.findById(t._id));
}

/** Spin up a game table for a 2-player match and notify the players. */
async function launchMatch(matchId) {
  const match = await ClanTournamentMatch.findById(matchId);
  if (!match || match.status !== "pending" || match.players.length !== 2) return;
  const t = await ClanTournament.findById(match.tournament).select("game name clan").lean();
  if (!t) return;

  let table = null;
  try {
    table = await tableFactory.createTournamentTable({
      gameType: t.game,
      matchId: match._id,
      capacity: t.game === "poker" ? 2 : 4,
    });
  } catch (e) {
    logger.warn("clan_tournament_table_create_failed", { reason: e?.message });
  }

  match.status = "live";
  match.tableId = table ? table._id : null;
  match.startedAt = new Date();
  match.deadlineAt = new Date(Date.now() + MATCH_DEADLINE_MS);
  await match.save();

  for (const uid of match.players) {
    clanRealtime.emitToUser(uid, "clan:match_ready", {
      tournamentId: String(match.tournament),
      matchId: String(match._id),
      tableId: table ? String(table._id) : null,
      game: t.game,
      round: match.round,
    });
    clanMembershipService.notify(uid, {
      title: "مباراة البطولة جاهزة",
      subtitle: `حان دورك في بطولة ${t.name}`,
      icon: "trophy",
      sourceType: "clan_match_ready",
      sourceId: String(match._id),
      meta: { tournamentId: String(match.tournament), matchId: String(match._id) },
    });
  }
  clanRealtime.emitToClan(match.clan, "clan:tournament_update", {
    type: "match_live",
    tournamentId: String(match.tournament),
    matchId: String(match._id),
  });
}

// ─── result reporting + advancement (the testable core primitive) ─────────────
/**
 * Record a match winner and advance the bracket. Idempotent via `advanced`.
 * `winnerUserId` must be one of the match players. Losers are eliminated with a
 * finishPlace derived from elimination order (later elimination = better place).
 */
async function reportMatchResult(matchId, winnerUserId, opts = {}) {
  const match = await ClanTournamentMatch.findById(matchId);
  if (!match) throw new ApiError("Match not found", 404);
  if (match.advanced) return { status: "already_resolved" };
  const winner = String(winnerUserId);
  if (!match.players.map(String).includes(winner)) {
    throw new ApiError("Winner must be a participant in the match", 400);
  }
  return resolveMatch(match, winner, opts);
}

async function resolveMatch(match, winnerUserId, opts = {}) {
  const winner = String(winnerUserId);

  /**
   * Atomically CLAIM this match before touching any money or bracket state.
   * A plain `if (match.advanced)` read-then-write lets concurrent duplicate
   * reports (retried settlement callbacks, double taps, the walkover ticker
   * racing a real result) both pass the check and advance the bracket twice —
   * which double-pays the final. The conditional update makes exactly one
   * caller win; everyone else sees `already_resolved`.
   */
  const claimed = await ClanTournamentMatch.findOneAndUpdate(
    { _id: match._id, advanced: false },
    {
      $set: {
        advanced: true,
        status: opts.walkover ? "walkover" : "finished",
        winner,
        result: opts.result || null,
        finishedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!claimed) return { status: "already_resolved" };
  match = claimed;

  const t = await ClanTournament.findById(match.tournament);
  if (!t || t.lifecycle === "finished" || t.lifecycle === "cancelled") {
    return { status: "tournament_closed" };
  }

  // Eliminate the loser(s) with a finish place.
  const losers = match.players.map(String).filter((u) => u !== winner);
  for (const loser of losers) {
    const placed = t.participants.filter((p) => p.finishPlace != null).length;
    const place = t.participants.length - placed; // first eliminated gets the worst place
    const part = t.participants.find((p) => String(p.user) === loser);
    if (part && part.finishPlace == null) {
      part.eliminated = true;
      part.finishPlace = place;
    }
  }
  await t.save();

  // Archive the match table (never move wallet coins for tournament tables).
  if (match.tableId) {
    tableFactory.destroyOrArchiveTable(match.tableId, { reason: "tournament_match_done" }).catch(() => {});
  }

  const isFinal = match.round >= t.rounds;
  if (isFinal) {
    await finishTournament(t._id, winner);
    return { status: "final", winner };
  }

  // Advance winner into the next round.
  const nextRound = match.round + 1;
  const nextIdx = match.nextMatchIndex != null ? match.nextMatchIndex : Math.floor(match.matchIndex / 2);
  const nextMatch = await ClanTournamentMatch.findOneAndUpdate(
    { tournament: t._id, round: nextRound, matchIndex: nextIdx },
    {
      $setOnInsert: {
        clan: t.clan,
        nextMatchIndex: Math.floor(nextIdx / 2),
        status: "pending",
      },
      $addToSet: { players: winner },
    },
    { upsert: true, new: true }
  );

  if (nextMatch.players.length === 2 && nextMatch.status === "pending") {
    await launchMatch(nextMatch._id);
  }
  clanRealtime.emitToClan(t.clan, "clan:tournament_update", {
    type: "match_result",
    tournamentId: String(t._id),
    matchId: String(match._id),
    winner,
  });
  return { status: "advanced", winner, nextMatchId: String(nextMatch._id) };
}

/**
 * Adapter for the unified game-finish hook. Given a settled tournament table's
 * game result, compute the match winner and advance the bracket. Returns
 * { handled:true } so the caller SKIPS cash settlement (tournaments use escrow).
 */
async function onMatchFinished({ table, gameType, gameResult, gamePlayers }) {
  try {
    const match = await ClanTournamentMatch.findById(table.clanTournamentMatch);
    if (!match || match.advanced) return { handled: true };

    const { resolveWinnerSeatIndices } = require("./gameSettlementService");
    const seatCount = (table.seats && table.seats.length) || (Array.isArray(gamePlayers) ? gamePlayers.length : 4);
    const winnerSeats = resolveWinnerSeatIndices(gameType, gameResult, seatCount);

    // Map winning seat → userId (from live gamePlayers, else the table seats).
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

    const matchPlayers = new Set(match.players.map(String));
    let winnerUserId = null;
    for (const seat of winnerSeats) {
      const u = seatUser.get(seat);
      if (u && matchPlayers.has(u)) {
        winnerUserId = u;
        break;
      }
    }
    // Fallback: if seats didn't map, pick the first match player present in gamePlayers.
    if (!winnerUserId) {
      logger.warn("clan_match_winner_unmapped", { matchId: String(match._id) });
      return { handled: true, resolved: false };
    }
    await reportMatchResult(match._id, winnerUserId, { result: { gameResult } });
    return { handled: true, resolved: true };
  } catch (e) {
    logger.error("clan_on_match_finished_failed", { reason: e?.message });
    return { handled: true, resolved: false };
  }
}

// ─── finish + payout (money-critical, reconciled) ─────────────────────────────
async function finishTournament(tournamentId, championUserId) {
  /**
   * Atomically CLAIM the payout. `new: false` returns the PRE-image, so the
   * single winning caller gets an authoritative snapshot of the participants and
   * escrow as they were at claim time. Any concurrent caller finds the lifecycle
   * already terminal and gets null — guaranteeing the prize pool is paid once.
   * If the payout itself fails we roll the lifecycle back so it can be retried.
   */
  const t = await ClanTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: { $nin: ["finished", "cancelled"] } },
    { $set: { lifecycle: "finished", finishedAt: new Date() } },
    { new: false }
  );
  if (!t) return;
  const previousLifecycle = t.lifecycle;

  // Champion gets place 1 (computed on the claimed snapshot).
  const champ = t.participants.find((p) => String(p.user) === String(championUserId));
  if (champ) {
    champ.finishPlace = 1;
    champ.eliminated = false;
  }

  const prizePool = toInt(t.prizePool);
  const dist = normalizeDistribution(t.prizeDistribution, t.participants.length);

  // Build payout list: place → userId with that finishPlace.
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
    // Any rounding/unallocated remainder goes to the champion (place 1).
    const remainder = prizePool - allocated;
    if (remainder > 0) {
      const champPayout = payouts.find((p) => p.place === 1);
      if (champPayout) champPayout.amount += remainder;
      else if (byPlace.get(1)) payouts.push({ userId: byPlace.get(1), place: 1, amount: remainder });
      else if (payouts[0]) payouts[0].amount += remainder;
    }
  }

  const totalPayout = payouts.reduce((s, p) => s + p.amount, 0);

  try {
    await withMongoTransaction(async (session) => {
      // Reconciliation first — a paid tournament can never pay out more than the
      // escrow it collected. Throwing here aborts before any coin moves.
      if (t.type === "paid" && totalPayout > toInt(t.escrowHeld)) {
        throw new Error(`TOURNAMENT_RECONCILIATION_FAILED:${totalPayout}>${t.escrowHeld}`);
      }
      // Friendly tournaments draw their prize pool from the clan treasury.
      if (t.type === "friendly" && totalPayout > 0) {
        await clanTreasuryService.debitTreasuryInSession(session, t.clan, totalPayout, {
          type: "tournament_payout",
          meta: { tournamentId: String(t._id) },
        });
      }
      for (const p of payouts) {
        await ledgerDeposit({
          session,
          userId: p.userId,
          amount: p.amount,
          ledgerType: "clan_tournament_prize",
          meta: { source: "clan_tournament_prize", tournamentId: String(t._id), place: p.place },
        });
      }
      await ClanTournament.updateOne(
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
    // Payout failed — release the claim so the tournament can be settled again
    // instead of being stranded as "finished" with nothing paid.
    await ClanTournament.updateOne(
      { _id: t._id, prizePaid: 0 },
      { $set: { lifecycle: previousLifecycle, finishedAt: null } }
    ).catch(() => {});
    logger.error("clan_tournament_payout_failed", {
      tournamentId: String(t._id),
      reason: err?.message,
    });
    throw err;
  }

  // Stats + achievements.
  const winStat = GAME_WIN_STAT[t.game] || "wins";
  await Clan.updateOne(
    { _id: t.clan },
    { $inc: { "stats.tournamentWins": 1, [`stats.${winStat}`]: 1, "stats.rankScore": 100 } }
  );
  await ClanMember.updateOne(
    { clan: t.clan, user: championUserId },
    { $inc: { "contribution.tournamentWins": 1 } }
  );
  try {
    require("./clanAchievementService").evaluateClan(t.clan).catch(() => {});
  } catch (_) {
    /* achievements optional until Phase G loaded */
  }

  // Notify + broadcast.
  for (const p of payouts) {
    clanMembershipService.notify(p.userId, {
      title: p.place === 1 ? "فزت بالبطولة!" : "جائزة البطولة",
      subtitle: `المركز ${p.place} — ${p.amount.toLocaleString("en-US")} عملة`,
      icon: "trophy",
      sourceType: "clan_tournament_prize",
      sourceId: `${t._id}:${p.userId}`,
      meta: { tournamentId: String(t._id), place: p.place, amount: p.amount },
    });
  }
  clanRealtime.emitToClan(t.clan, "clan:tournament_update", {
    type: "finished",
    tournamentId: String(t._id),
    champion: String(championUserId),
  });
  chatService
    .sendSystemMessage({
      channel: "clan",
      channelId: t.clan,
      actorId: championUserId,
      body: `انتهت بطولة ${t.name} 🏆`,
      meta: { event: "tournament_finished", tournamentId: String(t._id), champion: String(championUserId) },
    })
    .catch(() => {});
}

// ─── cancel (refund all escrow) ───────────────────────────────────────────────
async function cancelTournament(actorId, tournamentId, reason = "Cancelled", opts = {}) {
  const existing = await ClanTournament.findById(tournamentId);
  if (!existing) throw new ApiError("Tournament not found", 404);
  if (existing.lifecycle === "finished" || existing.lifecycle === "cancelled") {
    return { status: existing.lifecycle };
  }
  // Authorize against the current doc BEFORE claiming, so an unauthorized caller
  // never transitions the tournament.
  if (!opts.system && !opts.admin) {
    const clan = await Clan.findById(existing.clan);
    const actor = await ClanMember.findOne({ clan: existing.clan, user: actorId }).lean();
    const settings = await clanService.getSettings();
    const isCreator = String(existing.createdBy) === String(actorId);
    if (!actor || (!isCreator && !clanPermissionService.can(clan, actor.role, "createTournaments", settings))) {
      throw new ApiError("Not allowed to cancel this tournament", 403);
    }
  }

  /**
   * Atomically CLAIM the cancellation. `new: false` hands the single winning
   * caller the pre-image, i.e. the escrow snapshot to refund. Concurrent cancels
   * (or a cancel racing a payout) get null and refund nothing — so an entry fee
   * can never be refunded twice, nor refunded after being paid out as a prize.
   */
  const t = await ClanTournament.findOneAndUpdate(
    { _id: tournamentId, lifecycle: { $nin: ["finished", "cancelled"] } },
    {
      $set: {
        lifecycle: "cancelled",
        cancelledAt: new Date(),
        cancelReason: reason,
        escrowHeld: 0,
        prizePool: existing.manualPrizePool,
      },
    },
    { new: false }
  );
  if (!t) {
    const now = await ClanTournament.findById(tournamentId).select("lifecycle").lean();
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
            ledgerType: "clan_tournament_refund",
            meta: { source: "clan_tournament_cancel", tournamentId: String(t._id) },
          });
        }
      }
    });
  } catch (err) {
    // Refund failed — restore the claim so the cancellation can be retried
    // rather than leaving players out of pocket.
    await ClanTournament.updateOne(
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
    logger.error("clan_tournament_refund_failed", {
      tournamentId: String(t._id),
      reason: err?.message,
    });
    throw err;
  }

  // Archive any open match tables.
  const openMatches = await ClanTournamentMatch.find({ tournament: t._id, tableId: { $ne: null }, status: "live" });
  for (const m of openMatches) {
    tableFactory.destroyOrArchiveTable(m.tableId, { reason: "tournament_cancelled" }).catch(() => {});
  }

  clanRealtime.emitToClan(t.clan, "clan:tournament_update", {
    type: "cancelled",
    tournamentId: String(t._id),
    reason,
  });
  return { status: "cancelled" };
}

// ─── scheduler tick ─────────────────────────────────────────────────────────
async function tick() {
  const now = new Date();
  const toStart = await ClanTournament.find({ lifecycle: "registering", startAt: { $lte: now } })
    .select("_id")
    .limit(20)
    .lean();
  for (const row of toStart) {
    try {
      await startTournament(row._id);
    } catch (e) {
      logger.warn("clan_tournament_start_failed", { id: String(row._id), reason: e?.message });
    }
  }

  // Walkover: live matches past their deadline with no reported result.
  const stale = await ClanTournamentMatch.find({
    status: "live",
    advanced: false,
    deadlineAt: { $lte: now },
  })
    .limit(50)
    .lean();
  for (const m of stale) {
    try {
      // Deterministic fallback: the higher seed (players[0]) advances.
      const winner = m.players[0];
      if (winner) await reportMatchResult(m._id, winner, { walkover: true });
    } catch (e) {
      logger.warn("clan_walkover_failed", { id: String(m._id), reason: e?.message });
    }
  }
}

let _timer = null;
function startEngine({ intervalMs = 30000 } = {}) {
  if (_timer) return _timer;
  _timer = setInterval(() => {
    tick().catch((e) => logger.warn("clan_tournament_tick_failed", { reason: e?.message }));
  }, intervalMs);
  if (_timer.unref) _timer.unref();
  return _timer;
}
function stopEngine() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

// ─── serialization + reads ────────────────────────────────────────────────────
function serializeTournament(t) {
  return {
    id: String(t._id),
    clanId: String(t.clan),
    game: t.game,
    name: t.name,
    description: t.description || "",
    type: t.type,
    entryFee: t.entryFee,
    prizePool: t.prizePool,
    prizeDistribution: t.prizeDistribution || [],
    startAt: t.startAt,
    maxPlayers: t.maxPlayers,
    minPlayers: t.minPlayers,
    lifecycle: t.lifecycle,
    playerCount: t.participants ? t.participants.length : 0,
    rounds: t.rounds,
    winners: t.winners || [],
    createdBy: String(t.createdBy),
    createdAt: t.createdAt,
  };
}

async function listTournaments(clanId, { lifecycle } = {}) {
  const filter = { clan: clanId };
  if (lifecycle) filter.lifecycle = lifecycle;
  const rows = await ClanTournament.find(filter).sort({ startAt: -1 }).limit(50);
  return rows.map(serializeTournament);
}

async function getTournamentDetail(tournamentId) {
  const t = await ClanTournament.findById(tournamentId).populate("participants.user", "name profileImg");
  if (!t) throw new ApiError("Tournament not found", 404);
  const matches = await ClanTournamentMatch.find({ tournament: tournamentId })
    .sort({ round: 1, matchIndex: 1 })
    .lean();
  return {
    ...serializeTournament(t),
    participants: t.participants.map((p) => ({
      userId: String(p.user?._id || p.user),
      name: p.user?.name || null,
      avatar: p.user?.profileImg || null,
      seed: p.seed,
      eliminated: p.eliminated,
      finishPlace: p.finishPlace,
    })),
    bracket: matches.map((m) => ({
      id: String(m._id),
      round: m.round,
      matchIndex: m.matchIndex,
      players: m.players.map(String),
      status: m.status,
      winner: m.winner ? String(m.winner) : null,
      tableId: m.tableId ? String(m.tableId) : null,
    })),
  };
}

module.exports = {
  createTournament,
  register,
  unregister,
  startTournament,
  reportMatchResult,
  onMatchFinished,
  finishTournament,
  cancelTournament,
  tick,
  startEngine,
  stopEngine,
  listTournaments,
  getTournamentDetail,
  serializeTournament,
  defaultPrizeDistribution,
  _internal: { nextPowerOfTwo, normalizeDistribution },
};
