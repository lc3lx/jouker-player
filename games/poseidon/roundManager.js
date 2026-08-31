const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { FREE_SPINS_NATURAL, roundMoney } = require("./constants");

/**
 * Round metadata stays in-memory (short TTL).
 * Bonus sessions are cached in memory and persisted to Mongo in production
 * so buy-bonus / free-spins survive reconnects and process restarts.
 */

const rounds = new Map();
/** @type {Map<string, object>} */
const bonusSessions = new Map();

const ROUND_TTL_MS = 30 * 60 * 1000;

const PERSIST_MODE =
  process.env.POSEIDON_WALLET_MODE ||
  (process.env.NODE_ENV === "test" ? "stub" : "mongo");

function useMongo() {
  return PERSIST_MODE === "mongo";
}

function getSessionModel() {
  // Lazy require so stub/unit tests never need mongoose connected.
  return require("../../models/poseidonBonusSessionModel");
}

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

function sessionSnapshot(session) {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    betAmount: session.betAmount,
    freeSpinsRemaining: session.freeSpinsRemaining,
    totalWon: session.totalWon,
    superBonus: !!session.superBonus,
    bonusMultiplier: Number(session.bonusMultiplier || 0),
    createdAt: session.createdAt,
  };
}

async function persistSession(session) {
  if (!useMongo() || !session) return;
  try {
    const Model = getSessionModel();
    const now = Date.now();
    await Model.findOneAndUpdate(
      { userId: session.userId },
      {
        userId: session.userId,
        sessionId: session.sessionId,
        betAmount: session.betAmount,
        freeSpinsRemaining: session.freeSpinsRemaining,
        totalWon: session.totalWon,
        superBonus: !!session.superBonus,
        bonusMultiplier: Number(session.bonusMultiplier || 0),
        createdAt: session.createdAt,
        updatedAt: now,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    // Don't break gameplay if persistence blips — memory remains source for
    // this process; next ensureLoaded can heal from a prior write.
    console.error("[poseidon] bonus session persist failed:", err?.message || err);
  }
}

async function deletePersistedSession(userId) {
  if (!useMongo()) return;
  try {
    const Model = getSessionModel();
    await Model.deleteOne({ userId: String(userId) });
  } catch (err) {
    console.error("[poseidon] bonus session delete failed:", err?.message || err);
  }
}

/**
 * Hydrate memory cache from Mongo if needed. Call at the start of any
 * request that depends on bonus entitlement.
 */
async function ensureLoaded(userId) {
  const key = String(userId);
  if (bonusSessions.has(key)) return bonusSessions.get(key);
  if (!useMongo()) return null;
  try {
    const Model = getSessionModel();
    const doc = await Model.findOne({
      userId: key,
      freeSpinsRemaining: { $gt: 0 },
    }).lean();
    if (!doc) return null;
    const session = {
      sessionId: doc.sessionId,
      userId: key,
      betAmount: roundMoney(doc.betAmount),
      freeSpinsRemaining: Number(doc.freeSpinsRemaining) || 0,
      totalWon: roundMoney(doc.totalWon || 0),
      superBonus: !!doc.superBonus,
      bonusMultiplier: Number(doc.bonusMultiplier || 0),
      createdAt: doc.createdAt || Date.now(),
    };
    if (session.freeSpinsRemaining <= 0) return null;
    bonusSessions.set(key, session);
    return session;
  } catch (err) {
    console.error("[poseidon] bonus session load failed:", err?.message || err);
    return null;
  }
}

function createBonusSession(userId, {
  betAmount,
  freeSpins = FREE_SPINS_NATURAL,
  superBonus = false,
}) {
  const session = {
    sessionId: uuidv4(),
    userId: String(userId),
    betAmount: roundMoney(betAmount),
    freeSpinsRemaining: freeSpins,
    totalWon: 0,
    superBonus: !!superBonus,
    bonusMultiplier: 0,
    createdAt: Date.now(),
  };
  bonusSessions.set(String(userId), session);
  // Fire-and-forget persist; callers that need durability can await touchSession.
  void persistSession(session);
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
  void persistSession(session);
  return session;
}

function addBonusWin(userId, amount) {
  const session = getBonusSession(userId);
  if (!session) return null;
  session.totalWon = roundMoney(session.totalWon + amount);
  void persistSession(session);
  return session;
}

function setBonusMultiplier(userId, value) {
  const session = getBonusSession(userId);
  if (!session) return null;
  session.bonusMultiplier = Math.max(0, Number(value) || 0);
  void persistSession(session);
  return session;
}

/** Call after retrigger handling; deletes the session once it hits zero. */
function consumeBonusSpin(userId) {
  const session = getBonusSession(userId);
  if (!session || session.freeSpinsRemaining <= 0) return null;
  session.freeSpinsRemaining -= 1;
  if (session.freeSpinsRemaining <= 0) {
    bonusSessions.delete(String(userId));
    void deletePersistedSession(userId);
  } else {
    void persistSession(session);
  }
  return session;
}

/** Awaitable flush — use after buy-bonus so the charge + session land together. */
async function touchSession(userId) {
  const session = getBonusSession(userId);
  if (!session) {
    await deletePersistedSession(userId);
    return null;
  }
  await persistSession(session);
  return session;
}

async function clearAllForTests() {
  rounds.clear();
  bonusSessions.clear();
  if (useMongo()) {
    try {
      await getSessionModel().deleteMany({});
    } catch (_) {
      // ignore when mongoose isn't connected in unit tests
    }
  }
}

/** Sync clear for unit tests (memory only — stub mode). */
function clearAllForTestsSync() {
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
  addBonusWin,
  setBonusMultiplier,
  consumeBonusSpin,
  ensureLoaded,
  touchSession,
  clearAllForTests: clearAllForTestsSync,
  clearAllForTestsAsync: clearAllForTests,
  createRoundHash,
  sessionSnapshot,
};
