const { toSafeInt, isBotUserId } = require("../pokerTableStatus");

/** @enum {string} */
const PLAYER_STATE = {
  WAITING: "WAITING",
  SEATED: "SEATED",
  ACTIVE_HAND: "ACTIVE_HAND",
  SITTING_OUT: "SITTING_OUT",
  DISCONNECTED: "DISCONNECTED",
};

function defaultPlayerState(isHandRunning) {
  return isHandRunning ? PLAYER_STATE.WAITING : PLAYER_STATE.SEATED;
}

function isHumanSeat(seat) {
  return seat && !seat.isBot && !isBotUserId(String(seat.userId || ""));
}

/**
 * Humans eligible to participate in the *next* deal (not mid-hand waiters).
 */
function canParticipateInNextHand(seat) {
  if (!isHumanSeat(seat)) return false;
  if (toSafeInt(seat.chips, 0) <= 0) return false;
  const st = seat.playerState || PLAYER_STATE.SEATED;
  if (st === PLAYER_STATE.SITTING_OUT) return false;
  if (st === PLAYER_STATE.WAITING) return false;
  return true;
}

function canBeDealtIntoHand(seat) {
  if (!seat || toSafeInt(seat.chips, 0) <= 0) return false;
  if (seat.isBot) return true;
  const st = seat.playerState || PLAYER_STATE.SEATED;
  if (st === PLAYER_STATE.SITTING_OUT) return false;
  if (st === PLAYER_STATE.WAITING) return false;
  return true;
}

function promoteWaitingToSeated(seats) {
  for (const s of seats) {
    if (s.playerState === PLAYER_STATE.WAITING) {
      s.playerState = PLAYER_STATE.SEATED;
    }
  }
}

function markActiveHandParticipants(seats) {
  for (const s of seats) {
    if (s.inHand) {
      s.playerState = PLAYER_STATE.ACTIVE_HAND;
    } else if (
      isHumanSeat(s) &&
      s.playerState !== PLAYER_STATE.SITTING_OUT &&
      s.playerState !== PLAYER_STATE.DISCONNECTED
    ) {
      s.playerState = PLAYER_STATE.SEATED;
    }
  }
}

function countEligibleHumans(seats) {
  return seats.filter((s) => canParticipateInNextHand(s)).length;
}

function createSeatDefaults({ isHandRunning = false } = {}) {
  return {
    playerState: defaultPlayerState(isHandRunning),
    disconnectedAt: null,
    reconnectDeadline: null,
  };
}

module.exports = {
  PLAYER_STATE,
  defaultPlayerState,
  isHumanSeat,
  canParticipateInNextHand,
  canBeDealtIntoHand,
  promoteWaitingToSeated,
  markActiveHandParticipants,
  countEligibleHumans,
  createSeatDefaults,
};
