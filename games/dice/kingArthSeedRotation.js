/**
 * Per-user rotating serverSeed (provably fair).
 * Publishes hash upfront; after SPINS_PER_ROTATION completed spins, archives plaintext seed.
 */

const crypto = require("crypto");
const { sha256Hex } = require("./seededRng");

const SPINS_PER_ROTATION = Number(process.env.KING_ARTH_SPINS_PER_SEED) || 50;
const REVEALED_MAX = 40;

/** @type {import('redis').RedisClientType | null} */
let redis = null;

function setRedisClient(client) {
  redis = client && typeof client.hGetAll === "function" ? client : null;
}

function keyActive(userId) {
  return `ka:seed:active:${String(userId)}`;
}
function keyRevealed(userId) {
  return `ka:seed:revealed:${String(userId)}`;
}

const memSeeds = new Map();
const memRevealed = new Map();

function randomSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function memPushRevealed(userId, entry) {
  const uid = String(userId);
  const arr = memRevealed.get(uid) || [];
  arr.unshift(entry);
  memRevealed.set(uid, arr.slice(0, REVEALED_MAX));
}

function memEnsure(uid) {
  let s = memSeeds.get(uid);
  if (!s) {
    const seed = randomSeed();
    s = { seed, hash: sha256Hex(seed), spins: 0, generation: 1 };
    memSeeds.set(uid, s);
  }
  if (s.spins >= SPINS_PER_ROTATION) {
    memPushRevealed(uid, {
      serverSeed: s.seed,
      serverSeedHash: s.hash,
      generation: s.generation,
      revealedAt: Date.now(),
    });
    const seed = randomSeed();
    s = {
      seed,
      hash: sha256Hex(seed),
      spins: 0,
      generation: s.generation + 1,
    };
    memSeeds.set(uid, s);
  }
  return s;
}

function memAfterSpin(userId) {
  const s = memSeeds.get(String(userId));
  if (!s) return;
  s.spins += 1;
}

function getSeedForSpinMemory(userId) {
  const uid = String(userId);
  const before = memSeeds.get(uid) ? { ...memSeeds.get(uid) } : null;
  const s = memEnsure(uid);
  const rotated = !!(before && before.spins >= SPINS_PER_ROTATION);
  const revealed =
    rotated && before
      ? {
          serverSeed: before.seed,
          serverSeedHash: before.hash,
          generation: before.generation,
          revealedAt: Date.now(),
        }
      : undefined;
  return {
    seed: s.seed,
    serverSeedHash: s.hash,
    generation: s.generation,
    rotated,
    revealed,
  };
}

/**
 * @returns {Promise<{ seed: string, serverSeedHash: string, generation: number, rotated: boolean, revealed?: object }>}
 */
async function getSeedForSpin(userId) {
  if (!redis) {
    return getSeedForSpinMemory(userId);
  }

  const key = keyActive(userId);
  let h = await redis.hGetAll(key);
  if (!h || !h.seed) {
    const seed = randomSeed();
    const hash = sha256Hex(seed);
    await redis.hSet(key, {
      seed,
      hash,
      spins: "0",
      generation: "1",
    });
    h = await redis.hGetAll(key);
  }

  const spins = parseInt(h.spins || "0", 10);
  let generation = parseInt(h.generation || "1", 10);
  let seed = h.seed;
  let hash = h.hash;
  let rotated = false;
  let revealed;

  if (spins >= SPINS_PER_ROTATION) {
    revealed = {
      serverSeed: seed,
      serverSeedHash: hash,
      generation,
      revealedAt: Date.now(),
    };
    await redis.lPush(keyRevealed(userId), JSON.stringify(revealed));
    await redis.lTrim(keyRevealed(userId), 0, REVEALED_MAX - 1);
    seed = randomSeed();
    hash = sha256Hex(seed);
    generation += 1;
    rotated = true;
    await redis.hSet(key, { seed, hash, spins: "0", generation: String(generation) });
  }

  return { seed, serverSeedHash: hash, generation, rotated, revealed };
}

async function recordSpinCompleted(userId) {
  if (!redis) {
    memAfterSpin(userId);
    return;
  }
  const key = keyActive(userId);
  await redis.hIncrBy(key, "spins", 1);
}

/**
 * @returns {Promise<object[]>}
 */
async function listRevealedSeeds(userId) {
  if (!redis) {
    return memRevealed.get(String(userId)) || [];
  }
  const raw = await redis.lRange(keyRevealed(userId), 0, REVEALED_MAX - 1);
  return raw
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = {
  SPINS_PER_ROTATION,
  setRedisClient,
  getSeedForSpin,
  recordSpinCompleted,
  listRevealedSeeds,
};
