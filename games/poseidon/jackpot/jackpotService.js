/**
 * jackpotService — creates and persists Jackpot Rounds.
 *
 * Responsibilities:
 *   - Detect if a spin result triggers a jackpot (≥ JACKPOT_MIN_SYMBOLS)
 *   - Pick prize server-side
 *   - Generate card layout server-side
 *   - Persist the round to MongoDB (or in-memory stub for tests)
 *   - Return JackpotGameData for inclusion in the spin response
 *
 * This module does NOT touch the wallet. Settlement is in jackpotSettlement.js.
 */

const crypto = require("crypto");
const {
  JACKPOT_MIN_SYMBOLS,
  JACKPOT_STATUS,
  JACKPOT_ROUND_TTL_MS,
  JACKPOT_SYMBOL,
} = require("./jackpotConstants");
const { pickWeightedPrize, buildCardLayout } = require("./jackpotSelector");

const MODE =
  process.env.POSEIDON_WALLET_MODE ||
  (process.env.NODE_ENV === "test" ? "stub" : "mongo");

/** In-memory store for test/stub mode. */
const _stubRounds = new Map();

// ─── persistence helpers ────────────────────────────────────────────────────

async function _persistRound(round) {
  if (MODE !== "mongo") {
    _stubRounds.set(round.roundId, { ...round });
    return;
  }
  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  await PoseidonJackpotRound.create(round);
}

async function _loadRound(roundId) {
  if (MODE !== "mongo") {
    return _stubRounds.get(roundId) ?? null;
  }
  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  const doc = await PoseidonJackpotRound.findOne({ roundId });
  return doc ? doc.toObject() : null;
}

async function _updateRound(roundId, patch) {
  if (MODE !== "mongo") {
    const existing = _stubRounds.get(roundId);
    if (existing) {
      const updated = { ...existing, ...patch };
      _stubRounds.set(roundId, updated);
    }
    return;
  }
  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  await PoseidonJackpotRound.findOneAndUpdate({ roundId }, { $set: patch });
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Count jackpot scatter symbols on the final matrix.
 *
 * @param {string[][]} finalMatrix  — columns × rows
 * @returns {number}
 */
function countJackpotSymbols(finalMatrix) {
  let count = 0;
  for (const col of finalMatrix) {
    for (const cell of col) {
      if (cell === JACKPOT_SYMBOL) count++;
    }
  }
  return count;
}

/**
 * Should this spin result trigger a jackpot round?
 *
 * @param {string[][]} finalMatrix
 * @returns {boolean}
 */
function isJackpotTriggered(finalMatrix) {
  return countJackpotSymbols(finalMatrix) >= JACKPOT_MIN_SYMBOLS;
}

/**
 * Create a Jackpot Round for a triggered spin.
 *
 * @param {{spinId:string, userId:string}} opts
 * @param {()=>number} [rng]  — injectable for testing
 * @returns {Promise<object>}  JackpotGameData shape
 */
async function createJackpotRound({ spinId, userId }, rng) {
  const roundId = crypto.randomUUID();
  const prize = pickWeightedPrize(undefined, rng);
  const cards = buildCardLayout(prize, rng);

  const now = Date.now();
  const round = {
    roundId,
    spinId,
    userId: String(userId),
    prizeType: prize.type,
    prizeAmount: prize.amount,
    cards,
    revealedCards: [],
    status: JACKPOT_STATUS.PENDING,
    settlementId: null,
    revealedAt: null,
    settledAt: null,
    expiresAt: new Date(now + JACKPOT_ROUND_TTL_MS),
    createdAt: new Date(now),
  };

  await _persistRound(round);

  return _toGameData(round);
}

/**
 * Recover an existing Jackpot Round by roundId (reconnect / crash recovery).
 *
 * @param {string} roundId
 * @param {string} userId   — must match the stored userId
 * @returns {Promise<object|null>}  JackpotGameData or null if not found/expired
 */
async function recoverJackpotRound(roundId, userId) {
  const round = await _loadRound(roundId);
  if (!round) return null;
  if (round.userId !== String(userId)) return null;
  if (round.status === JACKPOT_STATUS.EXPIRED) return null;
  return _toGameData(round);
}

/**
 * Mark all cards as revealed (client has completed the scratch sequence).
 * Transitions status from pending/scratching → revealed.
 *
 * @param {string} roundId
 * @param {string} userId
 * @returns {Promise<object>}  updated JackpotGameData
 */
async function markJackpotRevealed(roundId, userId) {
  const round = await _loadRound(roundId);
  if (!round) throw new Error(`Jackpot round not found: ${roundId}`);
  if (round.userId !== String(userId)) throw new Error("Round user mismatch");
  if (round.status === JACKPOT_STATUS.SETTLED) return _toGameData(round);
  if (round.status === JACKPOT_STATUS.EXPIRED) throw new Error("Jackpot round expired");

  const allIndices = round.cards.map((c) => c.index);
  const patch = {
    status: JACKPOT_STATUS.REVEALED,
    revealedCards: allIndices,
    revealedAt: new Date(),
  };
  await _updateRound(roundId, patch);
  return _toGameData({ ...round, ...patch });
}

/**
 * Convert a stored round document into the client-facing JackpotGameData.
 * The card layout is always sent in full — the client cannot determine the
 * prize from this alone (prize is embedded, cards reveal it after animation).
 */
function _toGameData(round) {
  return {
    roundId: round.roundId,
    spinId: round.spinId,
    prizeType: round.prizeType,
    prizeAmount: round.prizeAmount,
    cards: round.cards.map((c) => ({
      index: c.index,
      prize: c.prize,
      amount: c.amount,
    })),
    revealedCards: round.revealedCards ?? [],
    status: round.status,
  };
}

// ─── test helpers ────────────────────────────────────────────────────────────

function _clearStubForTests() {
  _stubRounds.clear();
}

function _getStubRounds() {
  return _stubRounds;
}

module.exports = {
  countJackpotSymbols,
  isJackpotTriggered,
  createJackpotRound,
  recoverJackpotRound,
  markJackpotRevealed,
  _clearStubForTests,
  _getStubRounds,
};
