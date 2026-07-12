/**
 * Per-round provably-fair seed lifecycle for Sic Bo.
 *
 * When a round opens for betting we generate a secret serverSeed and publish only
 * sha256(serverSeed). The plaintext serverSeed is revealed at RESULT, after betting
 * has closed, so a player can reproduce the dice via games/dice/seededRng.js and the
 * published clientSeed/nonce — proving the outcome was fixed before any bet was seen.
 *
 * The authoritative record lives in the SicBoRound Mongo document. This module only
 * generates seeds and hashes (pure crypto), plus an optional per-round in-memory cache.
 */
const crypto = require("crypto");
const { sha256Hex } = require("../dice/seededRng");

/** Generate a fresh 32-byte hex serverSeed. */
function generateServerSeed() {
  return crypto.randomBytes(32).toString("hex");
}

/** Publish commitment for a serverSeed. */
function hashServerSeed(serverSeed) {
  return sha256Hex(serverSeed);
}

/**
 * Build the commitment published when a round opens for betting.
 * clientSeed is derived from the roundId so it is stable and reproducible; players
 * may still supply their own per-bet clientSeed for their personal verification view.
 * @param {string} roundId
 * @returns {{ serverSeed: string, serverSeedHash: string, clientSeed: string, nonce: string }}
 */
function createRoundCommitment(roundId) {
  const serverSeed = generateServerSeed();
  return {
    serverSeed,
    serverSeedHash: hashServerSeed(serverSeed),
    clientSeed: `sicbo:${String(roundId)}`,
    nonce: String(roundId),
  };
}

/**
 * Verify a revealed round: the hash must match and the dice must reproduce.
 * @param {object} params
 * @param {string} params.serverSeed
 * @param {string} params.serverSeedHash
 * @param {string} params.clientSeed
 * @param {string|number} params.nonce
 * @param {number[]} params.dice
 * @returns {{ valid: boolean, expectedDice: number[], hashOk: boolean, diceOk: boolean }}
 */
function verifyRound({ serverSeed, serverSeedHash, clientSeed, nonce, dice }) {
  const { rollDice } = require("./sicboEngine");
  const hashOk = hashServerSeed(serverSeed) === serverSeedHash;
  const expectedDice = rollDice(serverSeed, clientSeed, nonce);
  const diceOk =
    Array.isArray(dice) &&
    dice.length === 3 &&
    dice.every((d, i) => Number(d) === expectedDice[i]);
  return { valid: hashOk && diceOk, expectedDice, hashOk, diceOk };
}

module.exports = {
  generateServerSeed,
  hashServerSeed,
  createRoundCommitment,
  verifyRound,
};
