const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { FREE_SPINS_AWARD, roundMoney } = require("./constants");

/** In-memory round + bonus session store (swap for Redis/Mongo in production). */
const rounds = new Map();
const bonusSessions = new Map();

const ROUND_TTL_MS = 30 * 60 * 1000;

function purgeExpired() {
  const now = Date.now();
  for (const [id, round] of rounds.entries()) {
    if (round.expiresAt <= now) rounds.delete(id);
  }
}

function createRoundHash(roundId, userId, payload) {
  const secret =
    process.env.POSEIDON_HMAC_SECRET || "poseidon-dev-hmac-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(`${roundId}:${userId}:${JSON.stringify(payload)}`)
    .digest("hex");
}

function createRound({
  userId,
  betAmount,
  initialMatrix,
  steps,
  totalWin,
  isFreeSpin = false,
  bonusSessionId = null,
}) {
  purgeExpired();
  const roundId = uuidv4();
  const payload = { initialMatrix, steps: steps.length, totalWin, betAmount };
  const round = {
    roundId,
    roundHash: createRoundHash(roundId, userId, payload),
    userId: String(userId),
    betAmount: roundMoney(betAmount),
    totalWin: roundMoney(totalWin),
    isFreeSpin,
    bonusSessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ROUND_TTL_MS,
  };
  rounds.set(roundId, round);
  return round;
}

function getRound(roundId) {
  purgeExpired();
  return rounds.get(roundId) || null;
}

function createBonusSession(userId, { betAmount, freeSpins = FREE_SPINS_AWARD }) {
  const session = {
    sessionId: uuidv4(),
    userId: String(userId),
    betAmount: roundMoney(betAmount),
    freeSpinsRemaining: freeSpins,
    totalMultiplier: 0,
    totalWon: 0,
    createdAt: Date.now(),
  };
  bonusSessions.set(String(userId), session);
  return session;
}

function getBonusSession(userId) {
  return bonusSessions.get(String(userId)) || null;
}

function hasActiveBonusSession(userId) {
  const session = getBonusSession(userId);
  return session != null && session.freeSpinsRemaining > 0;
}

function addRetriggerSpins(userId, extraSpins) {
  const session = getBonusSession(userId);
  if (!session) return null;
  session.freeSpinsRemaining += extraSpins;
  return session;
}

/** Call after retrigger handling; deletes the session once it hits zero. */
function consumeBonusSpin(userId) {
  const session = getBonusSession(userId);
  if (!session || session.freeSpinsRemaining <= 0) return null;
  session.freeSpinsRemaining -= 1;
  if (session.freeSpinsRemaining <= 0) {
    bonusSessions.delete(String(userId));
  }
  return session;
}

function clearAllForTests() {
  rounds.clear();
  bonusSessions.clear();
}

module.exports = {
  createRound,
  getRound,
  createBonusSession,
  getBonusSession,
  hasActiveBonusSession,
  addRetriggerSpins,
  consumeBonusSpin,
  clearAllForTests,
  createRoundHash,
};
