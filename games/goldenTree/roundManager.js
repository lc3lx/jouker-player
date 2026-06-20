const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const {
  GAMBLE_MAX_ATTEMPTS_CAP,
  GAMBLE_MAX_WIN_MULTIPLIER,
  roundMoney,
} = require("./constants");

/** In-memory round + bonus session store (swap for Redis/Mongo in production). */
const rounds = new Map();
const bonusSessions = new Map();
const freeBetFlags = new Map();

const ROUND_TTL_MS = 30 * 60 * 1000;

function purgeExpired() {
  const now = Date.now();
  for (const [id, round] of rounds.entries()) {
    if (round.expiresAt <= now) rounds.delete(id);
  }
}

function createRoundHash(roundId, userId, payload) {
  const secret =
    process.env.GOLDEN_TREE_HMAC_SECRET || "golden-tree-dev-hmac-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(`${roundId}:${userId}:${JSON.stringify(payload)}`)
    .digest("hex");
}

function assignGambleAttempts() {
  return crypto.randomInt(1, GAMBLE_MAX_ATTEMPTS_CAP + 1);
}

function isGambleEligible(round) {
  if (!round || round.settled) return false;
  if (round.isFreeSpin || round.isBonusRound) return false;
  if (round.currentWin <= 0) return false;
  if (round.currentWin > roundMoney(round.betAmount * GAMBLE_MAX_WIN_MULTIPLIER)) {
    return false;
  }
  if (round.gambleAttemptsUsed >= round.maxGambleAttempts) return false;
  return true;
}

function createRound({
  userId,
  betAmount,
  matrix,
  expandedWilds,
  lineWins,
  scatterWins,
  totalWin,
  isFreeSpin = false,
  isBonusRound = false,
  bonusSessionId = null,
}) {
  purgeExpired();
  const roundId = uuidv4();
  const maxGambleAttempts = assignGambleAttempts();
  const payload = {
    matrix,
    expandedWilds,
    lineWins,
    scatterWins,
    totalWin,
    betAmount,
  };
  const roundHash = createRoundHash(roundId, userId, payload);

  const round = {
    roundId,
    roundHash,
    userId: String(userId),
    betAmount: roundMoney(betAmount),
    matrix,
    expandedWilds,
    lineWins,
    scatterWins,
    totalWin: roundMoney(totalWin),
    currentWin: roundMoney(totalWin),
    isFreeSpin,
    isBonusRound,
    bonusSessionId,
    maxGambleAttempts,
    gambleAttemptsUsed: 0,
    gambleHistory: [],
    settled: totalWin <= 0,
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

function getRoundForUser(roundId, userId) {
  const round = getRound(roundId);
  if (!round || round.userId !== String(userId)) return null;
  return round;
}

function settleRound(roundId) {
  const round = getRound(roundId);
  if (!round) return null;
  round.settled = true;
  return round;
}

function recordGamble(roundId, entry) {
  const round = getRound(roundId);
  if (!round) return null;
  round.gambleHistory.push(entry);
  round.gambleAttemptsUsed += 1;
  round.currentWin = roundMoney(entry.newWin);
  if (!entry.won || !isGambleEligible(round)) {
    round.settled = true;
  }
  return round;
}

function createBonusSession(userId, {
  bonusType,
  resolvedType,
  betAmount,
  sessionId = uuidv4(),
}) {
  const session = {
    sessionId,
    userId: String(userId),
    bonusType,
    resolvedType,
    betAmount: roundMoney(betAmount),
    freeSpinsRemaining: require("./constants").FREE_SPINS_PER_BONUS,
    gambleLocked: true,
    createdAt: Date.now(),
  };
  bonusSessions.set(String(userId), session);
  return session;
}

function getBonusSession(userId) {
  return bonusSessions.get(String(userId)) || null;
}

function consumeBonusSpin(userId) {
  const session = getBonusSession(userId);
  if (!session || session.freeSpinsRemaining <= 0) return null;
  session.freeSpinsRemaining -= 1;
  if (session.freeSpinsRemaining <= 0) {
    bonusSessions.delete(String(userId));
  }
  return session;
}

function hasActiveBonusSession(userId) {
  const session = getBonusSession(userId);
  return session != null && session.freeSpinsRemaining > 0;
}

function setFreeBetActive(userId, active) {
  freeBetFlags.set(String(userId), Boolean(active));
}

function hasFreeBet(userId) {
  return freeBetFlags.get(String(userId)) === true;
}

function clearAllForTests() {
  rounds.clear();
  bonusSessions.clear();
  freeBetFlags.clear();
}

module.exports = {
  createRound,
  getRound,
  getRoundForUser,
  settleRound,
  recordGamble,
  isGambleEligible,
  createBonusSession,
  getBonusSession,
  consumeBonusSpin,
  hasActiveBonusSession,
  setFreeBetActive,
  hasFreeBet,
  clearAllForTests,
  createRoundHash,
};
