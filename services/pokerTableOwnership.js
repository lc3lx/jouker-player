"use strict";

/**
 * H-3 table ownership — guarantees EXACTLY ONE authoritative instance per poker
 * table across a horizontally-scaled cluster.
 *
 * Mechanism: a Redis lease key `poker:owner:table:<id>` = `<instanceId>:<fence>`
 * taken with SET NX PX. The holder renews it on a sub-TTL heartbeat; if the
 * holder dies (kill -9, freeze, partition) the lease simply expires and another
 * instance may claim it. A monotonic `fence` (Redis INCR) is embedded so a
 * revived "zombie" owner can be detected and demoted.
 *
 * Only the lease holder runs the game loop (timers, deals, settlement, bots,
 * broadcasts). Every other instance is a passive follower that forwards mutating
 * commands to the current owner. See `pokerTableGameBridge` / `tableGame` wiring.
 */

const crypto = require("crypto");

function ownerKey(tableId) {
  return `poker:owner:table:${tableId}`;
}
function fenceKey(tableId) {
  return `poker:owner:fence:${tableId}`;
}

const RELEASE_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

const RENEW_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

function parseFence(value) {
  if (typeof value !== "string") return null;
  const idx = value.lastIndexOf(":");
  if (idx < 0) return null;
  const n = Number(value.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

function parseInstance(value) {
  if (typeof value !== "string") return null;
  const idx = value.lastIndexOf(":");
  return idx < 0 ? value : value.slice(0, idx);
}

class RedisTableOwnershipManager {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.instanceId =
      options.instanceId ||
      process.env.INSTANCE_ID ||
      `pid:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
    this.leaseTtlMs = Math.max(
      3000,
      Number(options.leaseTtlMs || process.env.POKER_OWNER_LEASE_TTL_MS || 15000)
    );
    /** tableId -> lease value we currently hold (`instanceId:fence`). */
    this.tokens = new Map();
  }

  isEnabled() {
    return !!this.redis;
  }

  /**
   * Try to become the owner. Returns { owned, fence, ownerId }.
   * Re-acquiring a lease we already hold is a no-op success.
   */
  async acquire(tableId) {
    const tid = String(tableId);
    if (!this.redis) return { owned: true, fence: 0, ownerId: this.instanceId };

    // Fast path: we already hold it — just confirm and renew.
    const held = this.tokens.get(tid);
    if (held) {
      const renewed = await this.renew(tid);
      if (renewed) return { owned: true, fence: parseFence(held), ownerId: this.instanceId };
      this.tokens.delete(tid);
    }

    const fence = Number(await this.redis.incr(fenceKey(tid)));
    const value = `${this.instanceId}:${fence}`;
    const ok = await this.redis.set(ownerKey(tid), value, {
      NX: true,
      PX: this.leaseTtlMs,
    });
    if (ok === "OK") {
      this.tokens.set(tid, value);
      return { owned: true, fence, ownerId: this.instanceId };
    }

    const current = await this.redis.get(ownerKey(tid));
    return { owned: false, fence: parseFence(current), ownerId: parseInstance(current) };
  }

  /** Extend our lease. Token-checked so we never extend someone else's. */
  async renew(tableId) {
    const tid = String(tableId);
    if (!this.redis) return true;
    const value = this.tokens.get(tid);
    if (!value) return false;
    try {
      const res = await this.redis.eval(RENEW_LUA, {
        keys: [ownerKey(tid)],
        arguments: [value, String(this.leaseTtlMs)],
      });
      if (res === 1) return true;
      // Lost the lease (expired + reclaimed elsewhere).
      this.tokens.delete(tid);
      return false;
    } catch (_) {
      return false;
    }
  }

  /** Release ownership (token-checked). Safe no-op if we don't hold it. */
  async release(tableId) {
    const tid = String(tableId);
    const value = this.tokens.get(tid);
    this.tokens.delete(tid);
    if (!this.redis || !value) return;
    try {
      await this.redis.eval(RELEASE_LUA, {
        keys: [ownerKey(tid)],
        arguments: [value],
      });
    } catch (_) {
      /* lease will expire on its own */
    }
  }

  /** True iff we currently believe we hold the lease locally. */
  ownsLocally(tableId) {
    return this.tokens.has(String(tableId));
  }

  /** instanceId of the current owner (or null if ownerless), per Redis. */
  async currentOwner(tableId) {
    if (!this.redis) return this.instanceId;
    const value = await this.redis.get(ownerKey(String(tableId)));
    return parseInstance(value);
  }

  /** All tableIds we currently hold a lease for. */
  ownedTableIds() {
    return [...this.tokens.keys()];
  }
}

/**
 * Single-instance fallback: this process owns every table unconditionally.
 * Keeps the engine behaviour identical to pre-H-3 when no Redis is configured.
 */
class InMemoryTableOwnershipManager {
  constructor(options = {}) {
    this.instanceId = options.instanceId || `local:${process.pid}`;
    this._fence = 0;
    this._owned = new Set();
  }

  isEnabled() {
    return false;
  }

  async acquire(tableId) {
    this._owned.add(String(tableId));
    this._fence += 1;
    return { owned: true, fence: this._fence, ownerId: this.instanceId };
  }

  async renew() {
    return true;
  }

  async release(tableId) {
    this._owned.delete(String(tableId));
  }

  ownsLocally(tableId) {
    return this._owned.has(String(tableId));
  }

  async currentOwner() {
    return this.instanceId;
  }

  ownedTableIds() {
    return [...this._owned];
  }
}

function createOwnershipManager(redis, options = {}) {
  return redis
    ? new RedisTableOwnershipManager(redis, options)
    : new InMemoryTableOwnershipManager(options);
}

module.exports = {
  RedisTableOwnershipManager,
  InMemoryTableOwnershipManager,
  createOwnershipManager,
  ownerKey,
  fenceKey,
  parseFence,
  parseInstance,
};
