/**
 * jackpotSelector — weighted prize selection + match-3 card layout.
 */

const crypto = require("crypto");
const { JACKPOT_PRIZES, JACKPOT_CARD_COUNT } = require("./jackpotConstants");

/** The three real jackpot tiers shown inside the 9 grid slots. */
const MATCH_PRIZE_TYPES = Object.freeze([
  { type: "super10m",  multiplier: 100 },
  { type: "mega50m",   multiplier: 500 },
  { type: "grand100m", multiplier: 1000 },
]);

function defaultRng() {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function pickWeightedPrize(prizes = JACKPOT_PRIZES, rng = defaultRng) {
  if (!Array.isArray(prizes) || prizes.length === 0) {
    throw new Error("jackpotSelector: prizes array must not be empty");
  }

  const total = prizes.reduce((sum, p) => {
    const w = typeof p.weight === "number" && p.weight > 0 ? p.weight : 0;
    return sum + w;
  }, 0);

  if (total <= 0) {
    throw new Error("jackpotSelector: all weights are zero or negative");
  }

  let roll = rng() * total;
  for (const prize of prizes) {
    const w = typeof prize.weight === "number" && prize.weight > 0 ? prize.weight : 0;
    roll -= w;
    if (roll < 0) return { type: prize.type, amount: prize.amount };
  }

  const last = prizes[prizes.length - 1];
  return { type: last.type, amount: last.amount };
}

/**
 * Build a 3×3 grid with exactly 3 of each prize type (100x / 500x / 1000x the triggering bet),
 * shuffled server-side. The player reveals cards until the first triple
 * appears — that type is the win.
 */
function buildMatchThreeLayout(betAmount) {
  if (!Number.isFinite(betAmount) || betAmount <= 0 ||
      !Number.isSafeInteger(Math.round(betAmount * 1000))) {
    throw new Error("Invalid jackpot betAmount");
  }
  const pool = [];
  for (const tier of MATCH_PRIZE_TYPES) {
    for (let i = 0; i < 3; i++) {
      pool.push({ prize: tier.type, amount: Math.round(betAmount * tier.multiplier) });
    }
  }

  // Fisher–Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool.map((entry, index) => ({
    index,
    prize: entry.prize,
    amount: entry.amount,
  }));
}

/**
 * Walk [revealedCards] in reveal order and return the first prize type
 * that reaches 3 matches, or null if the round is still open.
 */
function resolveFirstTriple(cards, revealedCards) {
  const counts = new Map();
  for (const idx of revealedCards) {
    const card = cards.find((c) => c.index === idx);
    if (!card || card.prize === "no_win") continue;
    const next = (counts.get(card.prize) ?? 0) + 1;
    counts.set(card.prize, next);
    if (next >= 3) {
      return { type: card.prize, amount: card.amount };
    }
  }
  return null;
}

/** @deprecated use buildMatchThreeLayout */
function buildCardLayout(selectedPrize, rng = defaultRng) {
  return buildMatchThreeLayout(100_000);
}

module.exports = {
  pickWeightedPrize,
  buildMatchThreeLayout,
  buildCardLayout,
  resolveFirstTriple,
  MATCH_PRIZE_TYPES,
  defaultRng,
};
