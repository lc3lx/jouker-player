/**
 * Tournament engine skeleton — additive orchestration over existing Tournament model.
 * Full MTT/SNG scheduling remains incremental; this service defines the contract.
 */
const Tournament = require("../models/tournamentModel");
const ApiError = require("../utils/apiError");
const auditService = require("./auditService");

const BLIND_SCHEDULES = {
  sitngo: [
    { level: 1, smallBlind: 50, bigBlind: 100, minutes: 5 },
    { level: 2, smallBlind: 100, bigBlind: 200, minutes: 5 },
  ],
  mtt: [
    { level: 1, smallBlind: 25, bigBlind: 50, minutes: 8 },
    { level: 2, smallBlind: 50, bigBlind: 100, minutes: 8 },
  ],
};

async function createTournament(payload) {
  const doc = await Tournament.create({
    name: payload.name,
    prize: payload.prize,
    entryFee: payload.entryFee || 0,
    durationMinutes: payload.durationMinutes || 60,
    startAt: payload.startAt || new Date(),
    status: "registering",
    tournamentType: payload.tournamentType || "sitngo",
    isPrivate: !!payload.isPrivate,
    lateRegistrationMinutes: payload.lateRegistrationMinutes || 0,
    blindSchedule: payload.blindSchedule || BLIND_SCHEDULES.sitngo,
    settings: payload.settings || {},
  });
  await auditService.logEvent({
    event: "tournament_created",
    tournament: doc._id,
    meta: { name: doc.name, type: doc.tournamentType },
  });
  return doc;
}

async function registerPlayer(tournamentId, userId) {
  const t = await Tournament.findById(tournamentId);
  if (!t) throw new ApiError("Tournament not found", 404);
  if (!["registering", "ongoing"].includes(t.status)) {
    throw new ApiError("Registration closed", 400);
  }
  const exists = (t.participants || []).some((p) => String(p.user) === String(userId));
  if (exists) throw new ApiError("Already registered", 400);
  t.participants.push({ user: userId, registeredAt: new Date() });
  await t.save();
  await auditService.logEvent({
    event: "tournament_register",
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

module.exports = {
  createTournament,
  registerPlayer,
  getBlindLevel,
  BLIND_SCHEDULES,
};
