const logger = require("./logger");

const CACHE_TTL_MS = 5000;
let _redis = null;
let _memory = { snapshot: null, expiresAt: 0 };
/** In-process payout locks when Redis is unavailable (single-node / tests). */
const _memLocks = new Map();

function setRedisClient(client) {
  _redis = client || null;
}

function attachRedisClient(client) {
  setRedisClient(client);
}

async function getCachedStatus(fetchFn) {
  const now = Date.now();
  if (_memory.snapshot && _memory.expiresAt > now) {
    return _memory.snapshot;
  }

  if (_redis) {
    try {
      const raw = await _redis.get("island:status:v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        _memory = { snapshot: parsed, expiresAt: now + CACHE_TTL_MS };
        return parsed;
      }
    } catch (err) {
      logger.warn("island_jackpot_cache_read_failed", { reason: err?.message });
    }
  }

  const fresh = await fetchFn();
  await setCachedStatus(fresh);
  return fresh;
}

async function setCachedStatus(snapshot) {
  const expiresAt = Date.now() + CACHE_TTL_MS;
  _memory = { snapshot, expiresAt };

  if (!_redis || !snapshot) return;
  try {
    await _redis.setEx("island:status:v1", Math.ceil(CACHE_TTL_MS / 1000), JSON.stringify(snapshot));
  } catch (err) {
    logger.warn("island_jackpot_cache_write_failed", { reason: err?.message });
  }
}

async function invalidateStatusCache() {
  _memory = { snapshot: null, expiresAt: 0 };
  if (!_redis) return;
  try {
    await _redis.del("island:status:v1");
  } catch (err) {
    logger.warn("island_jackpot_cache_invalidate_failed", { reason: err?.message });
  }
}

/**
 * Distributed lock for payout idempotency (best-effort without Redis).
 * @param {string} handId
 * @param {number} ttlSec
 */
async function acquirePayoutLock(handId, ttlSec = 90) {
  const key = `island:payout:lock:${handId}`;
  if (!_redis) {
    const now = Date.now();
    const expires = _memLocks.get(key);
    if (expires && expires > now) return { acquired: false, key };
    _memLocks.set(key, now + ttlSec * 1000);
    return { acquired: true, key };
  }
  try {
    const ok = await _redis.set(key, "1", { NX: true, EX: ttlSec });
    return { acquired: ok === "OK", key };
  } catch (err) {
    logger.warn("island_jackpot_lock_failed", { handId, reason: err?.message });
    return { acquired: true, key: null };
  }
}

async function releasePayoutLock(key) {
  if (!key) return;
  if (!_redis) {
    _memLocks.delete(key);
    return;
  }
  try {
    await _redis.del(key);
  } catch (_) {
    /* ignore */
  }
}

function resetCacheForTests() {
  _memory = { snapshot: null, expiresAt: 0 };
  _redis = null;
  _memLocks.clear();
}

module.exports = {
  setRedisClient,
  attachRedisClient,
  getCachedStatus,
  setCachedStatus,
  invalidateStatusCache,
  acquirePayoutLock,
  releasePayoutLock,
  resetCacheForTests,
};
