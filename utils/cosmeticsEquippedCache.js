/**
 * Equipped cosmetics cache: Redis when a client is attached (multi-instance safe),
 * else in-process Map (single-node fallback).
 */
const logger = require("./logger");

const PREFIX = "cosm_eq:";
const memory = new Map();

let redis = null;

function attachRedisClient(client) {
  redis = client && typeof client.get === "function" ? client : null;
}

function memoryTrim() {
  const max = Math.max(500, Number(process.env.COSMETICS_CACHE_MAX || 5000));
  if (memory.size <= max) return;
  const drop = memory.size - max;
  const keys = [...memory.keys()];
  for (let i = 0; i < drop; i++) memory.delete(keys[i]);
}

async function get(userId) {
  const key = String(userId || "");
  if (!key) return null;

  if (redis) {
    try {
      const raw = await redis.get(PREFIX + key);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? p : null;
    } catch (e) {
      logger.warn("cosmetics_equipped_cache_get_redis", { reason: e?.message || "unknown" });
    }
  }

  return memory.get(key) || null;
}

async function set(userId, payload) {
  const key = String(userId || "");
  if (!key || !payload || typeof payload !== "object") return;

  const ttl = Math.max(60, Number(process.env.COSMETICS_CACHE_TTL_SEC || 86400));

  if (redis) {
    try {
      await redis.set(PREFIX + key, JSON.stringify(payload), { EX: ttl });
      return;
    } catch (e) {
      logger.warn("cosmetics_equipped_cache_set_redis", { reason: e?.message || "unknown" });
    }
  }

  memory.set(key, {
    tableTheme: payload.tableTheme ?? null,
    cardSkin: payload.cardSkin ?? null,
    avatarFrame: payload.avatarFrame ?? null,
    skin: payload.skin ?? payload.avatarFrame ?? null,
  });
  memoryTrim();
}

async function del(userId) {
  const key = String(userId || "");
  if (!key) return;

  memory.delete(key);

  if (redis) {
    try {
      await redis.del(PREFIX + key);
    } catch (e) {
      logger.warn("cosmetics_equipped_cache_del_redis", { reason: e?.message || "unknown" });
    }
  }
}

module.exports = {
  attachRedisClient,
  get,
  set,
  del,
};
