/**
 * Tarneeb Syrian 41 — rules helpers (Jawaker reference).
 * Cards use lowercase suits from ../utils/cards: hearts, diamonds, clubs, spades.
 */

const { winningCardInTrick } = require("../utils/cards");

const MIN_DECLARE = 2;
const MAX_DECLARE = 13;
const SUM_MIN_TO_PLAY = 11;
const WIN_SCORE = 41;

/** Team: seats 0,2 vs 1,3 */
function getTeam(seatIndex) {
  return seatIndex % 2;
}

/** Opponent seats for player i (the two players on the other team). */
function opponentSeats(i) {
  return [(i + 1) % 4, (i + 3) % 4];
}

/**
 * Syrian rule: trump is the *other* suit of the same color.
 * clubs <-> spades, hearts <-> diamonds
 */
function oppositeColorSuit(suit) {
  const s = String(suit || "").toLowerCase();
  const map = {
    hearts: "diamonds",
    diamonds: "hearts",
    clubs: "spades",
    spades: "clubs",
  };
  return map[s] || null;
}

function normalizeRank(rank) {
  if (rank == null) return null;
  if (typeof rank === "number" && rank >= 2 && rank <= 14) return rank;
  const r = String(rank).toUpperCase();
  // Numeric ranks may come as strings (e.g. "10"). Handle them generically.
  if (/^\d+$/.test(r)) {
    const n = parseInt(r, 10);
    if (n >= 2 && n <= 14) return n;
  }
  const m = {
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };
  return m[r] ?? null;
}

function normalizeSuit(suit) {
  if (!suit) return null;
  const s = String(suit).toLowerCase();
  if (["hearts", "diamonds", "clubs", "spades"].includes(s)) return s;
  const cap = {
    Hearts: "hearts",
    Diamonds: "diamonds",
    Clubs: "clubs",
    Spades: "spades",
  };
  return cap[suit] || cap[String(suit).charAt(0).toUpperCase() + String(suit).slice(1)] || null;
}

/** Declare: 0 = pass (counts 0 toward sum), or 2..13 */
function validateDeclare(value) {
  if (value === null || value === undefined || value === "pass") {
    return { valid: true, v: 0 };
  }
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return { valid: false };
  if (n === 0) return { valid: true, v: 0 };
  if (n < MIN_DECLARE || n > MAX_DECLARE) return { valid: false };
  return { valid: true, v: n };
}

function getValidCards(hand, ledSuit) {
  if (!ledSuit) return [...hand];
  const ofSuit = hand.filter((c) => c.suit === ledSuit);
  return ofSuit.length > 0 ? ofSuit : [...hand];
}

function validateCardPlay(hand, card, ledSuit, trump) {
  const suit = normalizeSuit(card.suit);
  const rank = normalizeRank(card.rank);
  if (!suit || !rank) return { valid: false, reason: "invalid_card" };
  const c = { suit, rank };
  const idx = hand.findIndex((x) => x.suit === c.suit && x.rank === c.rank);
  if (idx < 0) return { valid: false, reason: "card_not_in_hand" };
  if (!ledSuit) return { valid: true, card: c };
  const hasLed = hand.some((x) => x.suit === ledSuit);
  if (hasLed && c.suit !== ledSuit) return { valid: false, reason: "must_follow_suit" };
  return { valid: true, card: c };
}

/**
 * End-of-round scoring (per player):
 * - Made bid: +bid to that player only.
 * - Failed: -bid from that player; split bid between the two opponents (team gets the points).
 */
function applyRoundScores(declaredBids, tricksThisRound, playerScores) {
  for (let i = 0; i < 4; i++) {
    const bid = declaredBids[i] || 0;
    const took = tricksThisRound[i] || 0;
    if (bid === 0) continue;
    if (took >= bid) {
      playerScores[i] += bid;
    } else {
      playerScores[i] -= bid;
      const [o1, o2] = opponentSeats(i);
      const half = Math.floor(bid / 2);
      const rest = bid - half;
      playerScores[o1] += half;
      playerScores[o2] += rest;
    }
  }
}

/** Game over: one team has a member >= 41 AND other team's total score > 0 */
function checkGameEnd(playerScores) {
  const t0 = playerScores[0] + playerScores[2];
  const t1 = playerScores[1] + playerScores[3];
  const max0 = Math.max(playerScores[0], playerScores[2]);
  const max1 = Math.max(playerScores[1], playerScores[3]);

  if (max0 >= WIN_SCORE && t1 > 0) {
    return { ended: true, winnerTeam: 0, playerScores };
  }
  if (max1 >= WIN_SCORE && t0 > 0) {
    return { ended: true, winnerTeam: 1, playerScores };
  }
  return { ended: false };
}

function toApiSuit(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toApiRank(r) {
  if (r === 11) return "J";
  if (r === 12) return "Q";
  if (r === 13) return "K";
  if (r === 14) return "A";
  return String(r);
}

module.exports = {
  MIN_DECLARE,
  MAX_DECLARE,
  SUM_MIN_TO_PLAY,
  WIN_SCORE,
  getTeam,
  opponentSeats,
  oppositeColorSuit,
  normalizeRank,
  normalizeSuit,
  validateDeclare,
  getValidCards,
  validateCardPlay,
  winningCardInTrick,
  applyRoundScores,
  checkGameEnd,
  toApiSuit,
  toApiRank,
};
