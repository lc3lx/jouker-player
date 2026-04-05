const crypto = require("crypto");

const RANKS = ["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const SUITS = ["c","d","h","s"];

function newDeck() {
  const deck = [];
  for (const r of RANKS) {
    for (const s of SUITS) {
      deck.push(r + s);
    }
  }
  return deck;
}

function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomInt(max) requires positive integer max");
  }

  // Node provides unbiased integer sampling.
  if (typeof crypto.randomInt === "function") {
    return crypto.randomInt(0, max);
  }

  // Fallback: rejection sampling to avoid modulo bias.
  const uint32Max = 0x100000000; // 2^32
  const limit = Math.floor(uint32Max / max) * max;
  while (true) {
    const x = crypto.randomBytes(4).readUInt32BE(0);
    if (x < limit) return x % max;
  }
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function randomIntFromSeed(max, seed, counter) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error("randomIntFromSeed(max) requires positive integer max");
  }
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}:${counter}`)
    .digest();
  // 48 bits from hash prefix, rejection to reduce modulo bias.
  const x = hash.readUIntBE(0, 6); // [0, 2^48)
  const space = 2 ** 48;
  const limit = Math.floor(space / max) * max;
  if (x >= limit) {
    return randomIntFromSeed(max, seed, counter + 1);
  }
  return x % max;
}

function shuffleDeterministic(deck, seed) {
  let counter = 0;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomIntFromSeed(i + 1, seed, counter++);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(deck.pop());
  }
  return out;
}

module.exports = {
  newDeck,
  shuffle,
  shuffleDeterministic,
  draw,
  sha256Hex,
  /** Unbiased [0, max) for bot timing / RNG outside provably-fair shuffle. */
  randomInt,
};
