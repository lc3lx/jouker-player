const crypto = require("crypto");

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
    const secret = String(process.env.POKER_SNAPSHOT_ENCRYPTION_KEY || "");
    this.encryptionKey = secret
      ? crypto.createHash("sha256").update(secret).digest()
      : null;
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
      const outer = JSON.parse(raw);
      if (!outer?.encrypted) return outer;
      if (!this.encryptionKey) return null;
      const iv = Buffer.from(outer.encrypted.iv, "base64");
      const tag = Buffer.from(outer.encrypted.tag, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([
        decipher.update(Buffer.from(outer.encrypted.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { ...JSON.parse(clear), ownerFence: outer.ownerFence };
    } catch (e) {
      return null;
    }
  }

  async save(tableId, snapshot, { finished = false, ownerFence = 0 } = {}) {
    if (!this.redis || !tableId || !snapshot) return false;
    const fence = toSafeInt(ownerFence, 0);
    let stored = { ...snapshot, ownerFence: fence };
    if (this.encryptionKey) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final()]);
      stored = {
        v: 2,
        ownerFence: fence,
        encrypted: {
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        },
      };
    }
    const payload = JSON.stringify(stored);

    if (typeof this.redis.eval === "function") {
      const result = await this.redis.eval(
        `
          local existing = redis.call("GET", KEYS[1])
          if existing then
            local ok, current = pcall(cjson.decode, existing)
            if ok and tonumber(current.ownerFence or 0) > tonumber(ARGV[2]) then
              return 0
            end
          end
          redis.call("SET", KEYS[1], ARGV[1])
          if ARGV[3] == "1" then
            redis.call("EXPIRE", KEYS[1], ARGV[4])
          else
            redis.call("PERSIST", KEYS[1])
          end
          return 1
        `,
        {
          keys: [this.key(tableId)],
          arguments: [payload, String(fence), finished ? "1" : "0", String(this.finishedTtlSec)],
        }
      );
      return Number(result) === 1;
    }

    const tx = this.redis.multi();
    tx.set(this.key(tableId), payload);
    if (finished) tx.expire(this.key(tableId), this.finishedTtlSec);
    else tx.persist(this.key(tableId));
    await tx.exec();
    return true;
  }

  async delete(tableId) {
    if (!this.redis || !tableId) return false;
    await this.redis.del(this.key(tableId));
    return true;
  }
}

module.exports = { RedisTableStateStore };
