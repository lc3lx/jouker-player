/**
 * @deprecated Legacy standalone tournament lifecycle engine.
 * Tournament engine — lifecycle orchestration over Tournament model.
 * Supports SNG, MTT, scheduled, satellite, freeroll, knockout, PKO, bounty, rebuy, add-on.
 *
 * Replaced by the ClanTournament bracket system (services/clanTournamentEngineService.js),
 * which has real transactional escrow, walkover, and cancellation handling
 * this engine never had. startEngine() is no longer called from server.js,
 * so its 15s-per-tournament lifecycle tick no longer runs, and
 * routes/tournamentRoute.js no longer calls any function in this file — see
 * docs/STANDALONE_TOURNAMENT_DISABLED.md for the full audit (including why:
 * eliminatePlayer() below is never called anywhere in production, so
 * advanceLifecycle can never reach "finished" for a 2+ player tournament,
 * and distributePrizes() is never wired to an actual wallet payout). Kept,
 * not deleted, for database compatibility and a possible future migration.
 */
const Tournament = require("../models/tournamentModel");
const ApiError = require("../utils/apiError");
const auditService = require("./auditService");
const logger = require("../utils/logger");

const LIFECYCLE = [
  "scheduled",
  "registering",
  "late_registration",
  "running",
  "breaking",
  "balancing",
  "final_table",
  "finished",
];

const BLIND_SCHEDULES = {
  sitngo: [
    { level: 1, smallBlind: 50, bigBlind: 100, ante: 0, minutes: 5 },
    { level: 2, smallBlind: 100, bigBlind: 200, ante: 0, minutes: 5 },
    { level: 3, smallBlind: 150, bigBlind: 300, ante: 25, minutes: 5 },
  ],
  mtt: [
    { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, minutes: 8 },
    { level: 2, smallBlind: 50, bigBlind: 100, ante: 0, minutes: 8 },
    { level: 3, smallBlind: 75, bigBlind: 150, ante: 25, minutes: 8 },
    { level: 4, smallBlind: 100, bigBlind: 200, ante: 25, minutes: 8 },
  ],
  knockout: [
    { level: 1, smallBlind: 50, bigBlind: 100, ante: 0, minutes: 6 },
    { level: 2, smallBlind: 100, bigBlind: 200, ante: 0, minutes: 6 },
  ],
};

const timers = new Map();

function defaultPrizeDistribution(count) {
  const pct = [50, 30, 20, 10, 5];
  return pct.slice(0, Math.min(count, 5)).map((p, i) => ({ place: i + 1, percent: p }));
}

function normalizeType(type) {
  const t = String(type || "sitngo").toLowerCase();
  if (["sitngo", "sit_and_go", "sng"].includes(t)) return "sitngo";
  if (["mtt", "multi_table"].includes(t)) return "mtt";
  if (["scheduled"].includes(t)) return "scheduled";
  if (["satellite"].includes(t)) return "satellite";
  if (["freeroll"].includes(t)) return "freeroll";
  if (["knockout", "pko", "progressive_knockout", "bounty"].includes(t)) return t;
  return t;
}

async function createTournament(payload) {
  const tournamentType = normalizeType(payload.tournamentType);
  const scheduleKey = ["mtt", "scheduled", "satellite"].includes(tournamentType) ? "mtt" : "sitngo";
  const doc = await Tournament.create({
    name: payload.name,
    prize: payload.prize,
    entryFee: payload.entryFee || 0,
    durationMinutes: payload.durationMinutes || 60,
    startAt: payload.startAt || new Date(),
    status: payload.startAt && new Date(payload.startAt) > new Date() ? "scheduled" : "registering",
    lifecycle: payload.startAt && new Date(payload.startAt) > new Date() ? "scheduled" : "registering",
    tournamentType,
    isPrivate: !!payload.isPrivate,
    lateRegistrationMinutes: payload.lateRegistrationMinutes || 0,
    blindSchedule: payload.blindSchedule || BLIND_SCHEDULES[scheduleKey] || BLIND_SCHEDULES.sitngo,
    prizeDistribution: payload.prizeDistribution || defaultPrizeDistribution(3),
    settings: {
      maxPlayers: payload.settings?.maxPlayers || 9,
      minPlayers: payload.settings?.minPlayers || 2,
      breakEveryLevels: payload.settings?.breakEveryLevels || 3,
      bountyAmount: payload.settings?.bountyAmount || 0,
      rebuyAllowed: !!payload.settings?.rebuyAllowed,
      addonAllowed: !!payload.settings?.addonAllowed,
      rebuyLevels: payload.settings?.rebuyLevels || 3,
      satelliteTargetId: payload.settings?.satelliteTargetId || null,
      ...payload.settings,
    },
    tables: [],
    eliminated: [],
    chipCounts: {},
    currentBlindLevel: 1,
    prizePool: payload.prize || 0,
    statistics: { handsPlayed: 0, tablesBalanced: 0, tablesMerged: 0 },
  });
  await auditService.logEvent({
    event: "tournament_created",
    tournament: doc._id,
    meta: { name: doc.name, type: doc.tournamentType },
  });
  scheduleTick(doc._id);
  return doc;
}

async function registerPlayer(tournamentId, userId, { rebuy = false, addon = false } = {}) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  const open = ["registering", "late_registration", "running"].includes(t.lifecycle || t.status);
  if (!open && !rebuy && !addon) throw new ApiError("Registration closed", 400);

  if (rebuy && !t.settings?.rebuyAllowed) throw new ApiError("Rebuy not allowed", 400);
  if (addon && !t.settings?.addonAllowed) throw new ApiError("Add-on not allowed", 400);

  const exists = (t.participants || []).some((p) => String(p.user) === String(userId));
  if (exists && !rebuy && !addon) throw new ApiError("Already registered", 400);

  if (!exists) {
    t.participants.push({
      user: userId,
      registeredAt: new Date(),
      chips: t.settings?.startingChips || 10000,
      bounty: t.settings?.bountyAmount || 0,
      rebuys: 0,
      addons: 0,
    });
  } else if (rebuy) {
    const p = t.participants.find((x) => String(x.user) === String(userId));
    p.rebuys = (p.rebuys || 0) + 1;
    p.chips = (p.chips || 0) + (t.settings?.startingChips || 10000);
  } else if (addon) {
    const p = t.participants.find((x) => String(x.user) === String(userId));
    p.addons = (p.addons || 0) + 1;
    p.chips = (p.chips || 0) + (t.settings?.addonChips || 5000);
  }

  t.prizePool = (t.prizePool || 0) + (rebuy || addon ? t.entryFee || 0 : t.entryFee || 0);
  await t.save();
  await auditService.logEvent({
    event: rebuy ? "tournament_rebuy" : addon ? "tournament_addon" : "tournament_register",
    actor: userId,
    tournament: t._id,
  });
  return t;
}

function getBlindLevel(tournament, elapsedMinutes = 0) {
  const schedule = tournament.blindSchedule || BLIND_SCHEDULES.sitngo;
  let acc = 0;
  for (const level of schedule) {
    acc += level.minutes || 5;
    if (elapsedMinutes < acc) return level;
  }
  return schedule[schedule.length - 1];
}

function buildTables(participants, maxPerTable = 9) {
  const alive = participants.filter((p) => !p.eliminated);
  const tables = [];
  let tableNum = 1;
  for (let i = 0; i < alive.length; i += maxPerTable) {
    const seats = alive.slice(i, i + maxPerTable).map((p, si) => ({
      user: p.user,
      seatIndex: si,
      chips: p.chips || 10000,
    }));
    tables.push({ tableNumber: tableNum++, seats, status: "active" });
  }
  return tables;
}

function balanceTables(tables) {
  if (tables.length < 2) return tables;
  const sorted = [...tables].sort((a, b) => a.seats.length - b.seats.length);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (max.seats.length - min.seats.length <= 1) return tables;
  const moved = max.seats.pop();
  if (moved) {
    moved.seatIndex = min.seats.length;
    min.seats.push(moved);
  }
  return sorted;
}

function mergeTables(tables) {
  if (tables.length < 2) return tables;
  const active = tables.filter((t) => t.status === "active");
  if (active.length < 2) return tables;
  const smallest = [...active].sort((a, b) => a.seats.length - b.seats.length)[0];
  if (smallest.seats.length > 2) return tables;
  const target = active.find((t) => t !== smallest && t.seats.length < 9);
  if (!target) return tables;
  for (const seat of smallest.seats) {
    seat.seatIndex = target.seats.length;
    target.seats.push(seat);
  }
  smallest.status = "merged";
  smallest.seats = [];
  return tables;
}

function distributePrizes(tournament) {
  const pool = tournament.prizePool || tournament.prize || 0;
  const dist = tournament.prizeDistribution || defaultPrizeDistribution(3);
  const ranked = [...(tournament.participants || [])].sort(
    (a, b) => (b.finishPlace || 999) - (a.finishPlace || 999)
  );
  return dist.map((d) => ({
    place: d.place,
    amount: Math.floor((pool * (d.percent || 0)) / 100),
    user: ranked.find((p) => p.finishPlace === d.place)?.user || null,
  }));
}

async function advanceLifecycle(tournamentId) {
  const t = await Tournament.findById(tournamentId);
  if (!t || t.lifecycle === "finished") return t;

  const now = Date.now();
  const startMs = new Date(t.startAt).getTime();
  const elapsedMin = Math.max(0, (now - startMs) / 60000);
  const blind = getBlindLevel(t, elapsedMin);

  if (t.lifecycle === "scheduled" && now >= startMs) {
    t.lifecycle = "registering";
    t.status = "registering";
  }

  const minPlayers = t.settings?.minPlayers || 2;
  const count = (t.participants || []).length;

  if (t.lifecycle === "registering" && count >= minPlayers) {
    if (t.lateRegistrationMinutes > 0) {
      t.lifecycle = "late_registration";
      t.status = "ongoing";
      t.lateRegistrationEndsAt = new Date(startMs + t.lateRegistrationMinutes * 60000);
    } else {
      t.lifecycle = "running";
      t.status = "ongoing";
      t.tables = buildTables(t.participants, t.settings?.maxPlayers || 9);
      t.startedAt = new Date();
    }
  }

  if (t.lifecycle === "late_registration" && t.lateRegistrationEndsAt && now >= new Date(t.lateRegistrationEndsAt).getTime()) {
    t.lifecycle = "running";
    t.tables = buildTables(t.participants, t.settings?.maxPlayers || 9);
    t.startedAt = new Date();
  }

  if (t.lifecycle === "running") {
    t.currentBlindLevel = blind.level || t.currentBlindLevel;
    t.currentBlinds = { small: blind.smallBlind, big: blind.bigBlind, ante: blind.ante || 0 };

    const breakEvery = t.settings?.breakEveryLevels || 0;
    if (breakEvery > 0 && t.currentBlindLevel % breakEvery === 0) {
      t.lifecycle = "breaking";
      t.breakEndsAt = new Date(now + 5 * 60000);
    }

    const alive = (t.participants || []).filter((p) => !p.eliminated);
    const totalSeats = (t.tables || []).reduce((s, tb) => s + tb.seats.length, 0);
    if (totalSeats > alive.length) {
      t.lifecycle = "balancing";
    }
    if (alive.length <= (t.settings?.maxPlayers || 9)) {
      t.lifecycle = "final_table";
      t.status = "final_table";
    }
    if (alive.length <= 2) {
      t.lifecycle = "final_table";
      t.isHeadsUp = true;
    }
    if (alive.length <= 1) {
      t.lifecycle = "finished";
      t.status = "history";
      t.finishedAt = new Date();
      t.prizes = distributePrizes(t);
    }
  }

  if (t.lifecycle === "breaking" && t.breakEndsAt && now >= new Date(t.breakEndsAt).getTime()) {
    t.lifecycle = "running";
    t.breakEndsAt = null;
  }

  if (t.lifecycle === "balancing") {
    t.tables = balanceTables(t.tables || []);
    t.statistics = t.statistics || {};
    t.statistics.tablesBalanced = (t.statistics.tablesBalanced || 0) + 1;
    t.tables = mergeTables(t.tables);
    t.statistics.tablesMerged = (t.statistics.tablesMerged || 0) + 1;
    t.lifecycle = "running";
  }

  await t.save();
  return t;
}

function scheduleTick(tournamentId) {
  if (timers.has(String(tournamentId))) return;
  const id = setInterval(() => {
    advanceLifecycle(tournamentId).catch((e) => {
      logger.warn("tournament_tick_failed", { tournamentId: String(tournamentId), reason: e?.message });
    });
  }, 15000);
  if (typeof id.unref === "function") id.unref();
  timers.set(String(tournamentId), id);
}

async function eliminatePlayer(tournamentId, userId, finishPlace) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  const p = (t.participants || []).find((x) => String(x.user) === String(userId));
  if (!p) throw new ApiError("Player not in tournament", 404);
  p.eliminated = true;
  p.eliminatedAt = new Date();
  p.finishPlace = finishPlace;
  t.eliminated.push({ user: userId, place: finishPlace, at: new Date() });

  const bountyTypes = ["knockout", "pko", "progressive_knockout", "bounty"];
  if (bountyTypes.includes(t.tournamentType) && t.settings?.bountyAmount) {
    p.bountyPaid = (p.bountyPaid || 0) + t.settings.bountyAmount;
  }

  await t.save();
  await auditService.logEvent({
    event: "tournament_elimination",
    actor: userId,
    tournament: t._id,
    meta: { finishPlace },
  });
  return t;
}

async function getTournamentLobby() {
  return Tournament.find({
    lifecycle: { $in: ["scheduled", "registering", "late_registration", "running", "final_table"] },
  })
    .sort({ startAt: 1 })
    .limit(50)
    .lean();
}

async function getTournamentStatistics(tournamentId) {
  const t = await Tournament.findById(tournamentId).lean();
  if (!t) throw new ApiError("Tournament not found", 404);
  return {
    tournamentId: String(t._id),
    name: t.name,
    type: t.tournamentType,
    lifecycle: t.lifecycle,
    participants: (t.participants || []).length,
    eliminated: (t.eliminated || []).length,
    tables: (t.tables || []).length,
    prizePool: t.prizePool,
    statistics: t.statistics || {},
    currentBlinds: t.currentBlinds,
  };
}

async function getLeaderboard(tournamentId) {
  const t = await Tournament.findById(tournamentId).populate("participants.user", "name country profileImg");
  if (!t) throw new ApiError("Tournament not found", 404);
  const ranked = [...(t.participants || [])].sort((a, b) => {
    if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
    return (b.chips || 0) - (a.chips || 0);
  });
  return ranked.map((p, i) => ({
    rank: i + 1,
    user: p.user,
    chips: p.chips || 0,
    eliminated: !!p.eliminated,
    finishPlace: p.finishPlace || null,
    rebuys: p.rebuys || 0,
    addons: p.addons || 0,
    bountyPaid: p.bountyPaid || 0,
  }));
}

function startEngine() {
  Tournament.find({ lifecycle: { $nin: ["finished"] } })
    .select("_id")
    .then((rows) => rows.forEach((r) => scheduleTick(r._id)))
    .catch(() => {});
}

module.exports = {
  createTournament,
  registerPlayer,
  getBlindLevel,
  advanceLifecycle,
  eliminatePlayer,
  getTournamentLobby,
  getTournamentStatistics,
  getLeaderboard,
  distributePrizes,
  balanceTables,
  mergeTables,
  buildTables,
  startEngine,
  BLIND_SCHEDULES,
  LIFECYCLE,
};
