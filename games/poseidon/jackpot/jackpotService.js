/**
 * jackpotService — creates and persists Jackpot Rounds.
 *
 * Match-3 flow:
 *   1. createJackpotRound → 9 cards (3× each tier), prizes hidden from client
 *   2. revealJackpotCard  → flip one card; first triple wins
 *   3. settle (jackpotSettlement) → wallet credit
 */

const crypto = require("crypto");
const {
  JACKPOT_MIN_SYMBOLS,
  JACKPOT_FORCE_EVERY_SPIN,
  JACKPOT_STATUS,
  JACKPOT_ROUND_TTL_MS,
  JACKPOT_SYMBOL,
} = require("./jackpotConstants");
const {
  buildMatchThreeLayout,
  resolveFirstTriple,
} = require("./jackpotSelector");

const MODE =
  process.env.POSEIDON_WALLET_MODE ||
  (process.env.NODE_ENV === "test" ? "stub" : "mongo");

const _stubRounds = new Map();

function _cloneRound(round) {
  return JSON.parse(JSON.stringify(round));
}

async function _persistRound(round) {
  // Always keep an in-process copy so reveal works even if Mongo is slow/down.
  _stubRounds.set(round.roundId, _cloneRound(round));

  if (MODE !== "mongo") return;

  try {
    const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
    await PoseidonJackpotRound.create(round);
  } catch (err) {
    // Non-fatal: in-memory round remains available for reveal/settle in this process.
    const logger = (() => {
      try {
        return require("../../../utils/logger");
      } catch {
        return console;
      }
    })();
    logger.error?.("jackpot mongo persist failed", { err: err?.message, roundId: round.roundId });
  }
}

async function _loadRound(roundId) {
  if (MODE === "mongo") {
    try {
      const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
      const doc = await PoseidonJackpotRound.findOne({ roundId });
      if (doc) {
        const obj = doc.toObject();
        _stubRounds.set(roundId, obj);
        return obj;
      }
    } catch (_) {
      // Fall through to in-memory copy.
    }
  }
  const mem = _stubRounds.get(roundId);
  return mem ? { ...mem, cards: [...(mem.cards ?? [])], revealedCards: [...(mem.revealedCards ?? [])] } : null;
}

async function _updateRound(roundId, patch) {
  const existing = _stubRounds.get(roundId);
  if (existing) {
    const next = {
      ...existing,
      ...patch,
      cards: patch.cards ?? existing.cards,
      revealedCards: patch.revealedCards ?? existing.revealedCards,
    };
    _stubRounds.set(roundId, next);
  }

  if (MODE !== "mongo") return;

  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  await PoseidonJackpotRound.findOneAndUpdate({ roundId }, { $set: patch });
}

function countJackpotSymbols(finalMatrix) {
  let count = 0;
  for (const col of finalMatrix) {
    for (const cell of col) {
      if (cell === JACKPOT_SYMBOL) count++;
    }
  }
  return count;
}

function isJackpotTriggered(finalMatrix) {
  if (JACKPOT_FORCE_EVERY_SPIN && process.env.NODE_ENV !== "test") return true;
  return countJackpotSymbols(finalMatrix) >= JACKPOT_MIN_SYMBOLS;
}

async function createJackpotRound({ spinId, userId, game = "poseidon" }) {
  const roundId = crypto.randomUUID();
  const cards = buildMatchThreeLayout();

  const now = Date.now();
  const round = {
    roundId,
    spinId,
    userId: String(userId),
    game: game === "king-arth" ? "king-arth" : "poseidon",
    prizeType: "pending",
    prizeAmount: 0,
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

async function recoverJackpotRound(roundId, userId) {
  const round = await _loadRound(roundId);
  if (!round) return null;
  if (round.userId !== String(userId)) return null;
  if (round.status === JACKPOT_STATUS.EXPIRED) return null;
  return _toGameData(round);
}

/**
 * Reveal a single card. Returns the card face + whether a triple was matched.
 */
async function revealJackpotCard(roundId, userId, cardIndex) {
  const round = await _loadRound(roundId);
  if (!round) throw new Error(`Jackpot round not found: ${roundId}`);
  if (round.userId !== String(userId)) throw new Error("Round user mismatch");
  if (round.status === JACKPOT_STATUS.SETTLED) {
    return _buildRevealResponse(round, cardIndex, true);
  }
  if (round.status === JACKPOT_STATUS.EXPIRED) {
    throw new Error("Jackpot round expired");
  }

  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= round.cards.length) {
    throw new Error("Invalid card index");
  }

  const revealed = [...(round.revealedCards ?? [])];
  if (revealed.includes(idx)) {
    const card = round.cards.find((c) => c.index === idx);
    return {
      card: { index: idx, prize: card.prize, amount: card.amount },
      matched: round.prizeType !== "pending",
      prizeType: round.prizeType === "pending" ? null : round.prizeType,
      prizeAmount: round.prizeAmount,
      gameOver: round.status === JACKPOT_STATUS.REVEALED,
    };
  }

  revealed.push(idx);
  const card = round.cards.find((c) => c.index === idx);
  const triple = resolveFirstTriple(round.cards, revealed);

  const patch = {
    revealedCards: revealed,
    status: triple ? JACKPOT_STATUS.REVEALED : JACKPOT_STATUS.SCRATCHING,
  };

  if (triple) {
    patch.prizeType = triple.type;
    patch.prizeAmount = triple.amount;
    patch.revealedAt = new Date();
  }

  await _updateRound(roundId, patch);
  const updated = { ...round, ...patch };

  return {
    card: { index: idx, prize: card.prize, amount: card.amount },
    matched: !!triple,
    prizeType: triple?.type ?? null,
    prizeAmount: triple?.amount ?? 0,
    gameOver: !!triple,
    counts: _countRevealed(updated.cards, revealed),
  };
}

function _countRevealed(cards, revealedCards) {
  const counts = { super10m: 0, mega50m: 0, grand100m: 0 };
  for (const idx of revealedCards) {
    const card = cards.find((c) => c.index === idx);
    if (card && counts[card.prize] !== undefined) {
      counts[card.prize] += 1;
    }
  }
  return counts;
}

function _buildRevealResponse(round, cardIndex, alreadySettled) {
  const card = round.cards.find((c) => c.index === cardIndex);
  return {
    card: card
      ? { index: card.index, prize: card.prize, amount: card.amount }
      : null,
    matched: round.prizeType !== "pending",
    prizeType: round.prizeType === "pending" ? null : round.prizeType,
    prizeAmount: round.prizeAmount,
    gameOver: round.status === JACKPOT_STATUS.REVEALED || alreadySettled,
  };
}

/** Client-facing payload — unrevealed card prizes are never sent. */
function _toGameData(round) {
  const revealedSet = new Set(round.revealedCards ?? []);
  return {
    roundId: round.roundId,
    spinId: round.spinId,
    prizeType: round.prizeType === "pending" ? null : round.prizeType,
    prizeAmount: round.prizeAmount ?? 0,
    cards: round.cards.map((c) => {
      if (revealedSet.has(c.index)) {
        return { index: c.index, prize: c.prize, amount: c.amount };
      }
      return { index: c.index };
    }),
    revealedCards: round.revealedCards ?? [],
    status: round.status,
  };
}

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
  revealJackpotCard,
  _clearStubForTests,
  _getStubRounds,
};
