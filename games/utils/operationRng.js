"use strict";

const crypto = require("node:crypto");

/**
 * Deterministic, crypto-strength RNG for one slot operation.
 *
 * The seed is drawn once per request, outside the Mongo transaction, so a
 * transaction retry replays the exact same outcome instead of re-rolling it.
 * A re-roll would make the realized RTP differ from the published one, because
 * winning spins write more documents and therefore abort more often.
 *
 * Output: HMAC-SHA256(seed, counter) split into 32-bit words → [0, 1).
 */

const WORDS_PER_BLOCK = 8;

function newOperationSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function createOperationRng(seed) {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("createOperationRng: seed must be a non-empty string");
  }
  const key = Buffer.from(seed, "utf8");
  let counter = 0;
  let block = null;
  let word = WORDS_PER_BLOCK;
  return function operationRandom() {
    if (word >= WORDS_PER_BLOCK) {
      block = crypto.createHmac("sha256", key).update(String(counter)).digest();
      counter += 1;
      word = 0;
    }
    const value = block.readUInt32BE(word * 4);
    word += 1;
    return value / 2 ** 32;
  };
}

module.exports = { newOperationSeed, createOperationRng };
