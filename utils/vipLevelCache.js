/**
 * VIP level cache: userId -> { level: "bronze"|"silver"|"gold"|"platinum"|null }.
 * Redis-backed when a client is attached (multi-instance safe) with an
 * in-process write-through Map so game loops can read synchronously
 * (`peekSync`) without touching the event loop.
 */
const logger = require("./logger");

const PREFIX = "vip_lv:";
const memory = new Map();

let redis = null;

function attachRedisClient(client) {
  redis = client && typeof client.get === "function" ? client : null;
}

function ttlSec() {
  return Math.max(30, Number(process.env.VIP_CACHE_TTL_SEC || 300));
}

function memoryTrim() {
  const max = Math.max(500, Number(process.env.VIP_CACHE_MAX || 10000));
  if (memory.size <= max) return;
  const drop = memory.size - max;
  const keys = [...memory.keys()];
  for (let i = 0; i < drop; i++) memory.delete(keys[i]);
}

function normalizeEntry(payload) {
  if (!payload || typeof payload !== "object") return null;
  return { level: payload.level ?? null, at: Number(payload.at) || Date.now() };
}

function memoryGet(key) {
  const row = memory.get(key);
  if (!row) return null;
  if (Date.now() - row.at > ttlSec() * 1000) {
    memory.delete(key);
    return null;
  }
  return row;
}

async function get(userId) {
  const key = String(userId || "");
  if (!key) return null;

  const local = memoryGet(key);
  if (local) return local;

  if (redis) {
    try {
      const raw = await redis.get(PREFIX + key);
      if (raw) {
        const p = normalizeEntry(JSON.parse(raw));
        if (p) {
          memory.set(key, p);
          memoryTrim();
          return p;
        }
      }
    } catch (e) {
      logger.warn("vip_level_cache_get_redis", { reason: e?.message || "unknown" });
    }
  }
  return null;
}

async function set(userId, level) {
  const key = String(userId || "");
  if (!key) return;

  const entry = { level: level ?? null, at: Date.now() };
  memory.set(key, entry);
  memoryTrim();

  if (redis) {
    try {
      await redis.set(PREFIX + key, JSON.stringify(entry), { EX: ttlSec() });
    } catch (e) {
      logger.warn("vip_level_cache_set_redis", { reason: e?.message || "unknown" });
    }
  }
}

async function del(userId) {
  const key = String(userId || "");
  if (!key) return;

  memory.delete(key);

  if (redis) {
    try {
      await redis.del(PREFIX + key);
    } catch (e) {
      logger.warn("vip_level_cache_del_redis", { reason: e?.message || "unknown" });
    }
  }
}

/**
 * Synchronous read of the local write-through copy (no Redis round-trip).
 * Returns the level string, null (known non-VIP) or undefined (not cached).
 */
function peekSync(userId) {
  const row = memoryGet(String(userId || ""));
  return row ? row.level : undefined;
}

function clearForTests() {
  memory.clear();
}

module.exports = {
  attachRedisClient,
  get,
  set,
  del,
  peekSync,
  clearForTests,
};
