function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

class RedisTableStateStore {
  constructor(redisClient = null) {
    this.redis = redisClient || null;
    this.statePrefix = "table_state";
    this.finishedTtlSec = Math.max(
      60,
      toSafeInt(process.env.POKER_FINISHED_TABLE_TTL_SEC, 3600)
    );
  }

  key(tableId) {
    return `${this.statePrefix}:${tableId}`;
  }

  isEnabled() {
    return !!this.redis;
  }

  async load(tableId) {
    if (!this.redis || !tableId) return null;
    const raw = await this.redis.get(this.key(tableId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async save(tableId, snapshot, { finished = false } = {}) {
    if (!this.redis || !tableId || !snapshot) return false;
    const payload = JSON.stringify(snapshot);

    const tx = this.redis.multi();
    tx.set(this.key(tableId), payload);
    if (finished) tx.expire(this.key(tableId), this.finishedTtlSec);
    else tx.persist(this.key(tableId));
    await tx.exec();
    return true;
  }
}

module.exports = { RedisTableStateStore };

