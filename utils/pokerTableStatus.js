/** @typedef {'waiting'|'ready'|'playing'|'full'|'frozen'|'closed'} PokerTableStatus */

const POKER_CAPACITY = 9;
const POKER_MIN_PLAYERS = 2;

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function isBotUserId(userId) {
  return typeof userId === "string" && userId.startsWith("bot:");
}

/**
 * Human seats with chips from in-memory engine seats.
 * @param {Array<{ userId?: string, isBot?: boolean, chips?: number }>} seats
 */
function countHumanSeatsFromEngine(seats) {
  if (!Array.isArray(seats)) return 0;
  return seats.filter(
    (s) =>
      s &&
      !s.isBot &&
      !isBotUserId(String(s.userId || "")) &&
      toSafeInt(s.chips, 0) > 0
  ).length;
}

/** Mongo seats are always humans. */
function countMongoSeats(seats) {
  return Array.isArray(seats) ? seats.length : 0;
}

function normalizeCapacity(capacity) {
  return Math.max(2, Math.min(POKER_CAPACITY, toSafeInt(capacity, POKER_CAPACITY)));
}

/**
 * @param {{ mongoSeatCount: number, capacity?: number, running?: boolean, round?: string }} input
 * @returns {PokerTableStatus}
 */
function derivePokerTableStatus({ mongoSeatCount, capacity, running, round, frozen }) {
  if (frozen === true) return "frozen";
  const cap = normalizeCapacity(capacity);
  const seated = Math.max(0, toSafeInt(mongoSeatCount, 0));
  if (seated >= cap) return "full";
  const playing = running === true && round && String(round) !== "idle";
  if (playing) return "playing";
  if (seated < POKER_MIN_PLAYERS) return "waiting";
  return "ready";
}

/**
 * Lobby / socket metadata exposed to clients.
 * @param {{ mongoSeatCount?: number, engineSeats?: Array, capacity?: number, running?: boolean, round?: string }} input
 */
function buildPokerLobbyFields(input = {}) {
  const cap = normalizeCapacity(input.capacity);
  const seatedCount =
    input.mongoSeatCount != null
      ? Math.max(0, toSafeInt(input.mongoSeatCount, 0))
      : countHumanSeatsFromEngine(input.engineSeats || []);
  const tableStatus = derivePokerTableStatus({
    mongoSeatCount: seatedCount,
    capacity: cap,
    running: input.running,
    round: input.round,
    frozen: input.frozen === true,
  });
  return {
    capacity: cap,
    seatedCount,
    playersNeeded: Math.max(0, POKER_MIN_PLAYERS - seatedCount),
    tableStatus,
    canStart: seatedCount >= POKER_MIN_PLAYERS && tableStatus !== "full",
  };
}

module.exports = {
  POKER_CAPACITY,
  POKER_MIN_PLAYERS,
  toSafeInt,
  isBotUserId,
  countHumanSeatsFromEngine,
  countMongoSeats,
  normalizeCapacity,
  derivePokerTableStatus,
  buildPokerLobbyFields,
};
