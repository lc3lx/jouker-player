/**
 * Sic Bo distributed state: engine leader-lock (heartbeat + TTL renewal + failover)
 * and a fast round-header cache. Redis when available, in-memory fallback for
 * single-node / dev / tests. Financial data NEVER lives here — only ephemeral
 * coordination and a cache rebuildable from Mongo.
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");

let _redis = null;
/** This process's unique id — identifies the current leader. */
const NODE_ID = `${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

const LEADER_KEY = "sicbo:engine:leader";
const CACHE_KEY = "sicbo:round:state:v1";
const LEADER_TTL_SEC = 15; // lock expires if a dead leader stops renewing

let _memLeader = { owner: null, expiresAt: 0 };
let _memCache = null;

function setRedisClient(client) {
  _redis = client && typeof client.set === "function" ? client : null;
}

function nodeId() {
  return NODE_ID;
}

/**
 * Try to become (or remain) the engine leader. Only the leader advances rounds.
 * Uses SET NX to acquire; if we already own it, refresh the TTL (heartbeat renewal).
 * @returns {Promise<boolean>} true if this node holds leadership after the call.
 */
async function acquireOrRenewLeadership() {
  if (!_redis) {
    const now = Date.now();
    if (!_memLeader.owner || _memLeader.owner === NODE_ID || _memLeader.expiresAt <= now) {
      _memLeader = { owner: NODE_ID, expiresAt: now + LEADER_TTL_SEC * 1000 };
      return true;
    }
    return false;
  }

  try {
    // Fast path: we already own it → renew TTL only if still ours (atomic-ish).
    const current = await _redis.get(LEADER_KEY);
    if (current === NODE_ID) {
      await _redis.set(LEADER_KEY, NODE_ID, { EX: LEADER_TTL_SEC });
      return true;
    }
    // Otherwise try to grab a vacant lock.
    const ok = await _redis.set(LEADER_KEY, NODE_ID, { NX: true, EX: LEADER_TTL_SEC });
    return ok === "OK";
  } catch (err) {
    logger.warn("sicbo_leader_lock_failed", { reason: err?.message });
    // On Redis error, do not advance the round (avoid split-brain double settlement).
    return false;
  }
}

/** Release leadership (best-effort) — only if we still own it. */
async function releaseLeadership() {
  if (!_redis) {
    if (_memLeader.owner === NODE_ID) _memLeader = { owner: null, expiresAt: 0 };
    return;
  }
  try {
    const current = await _redis.get(LEADER_KEY);
    if (current === NODE_ID) await _redis.del(LEADER_KEY);
  } catch (_) {
    /* ignore */
  }
}

/** Cache the public round header for fast reads / cross-node re-broadcast. */
async function setStateCache(snapshot) {
  _memCache = snapshot || null;
  if (!_redis || !snapshot) return;
  try {
    await _redis.set(CACHE_KEY, JSON.stringify(snapshot), { EX: 120 });
  } catch (err) {
    logger.warn("sicbo_state_cache_write_failed", { reason: err?.message });
  }
}

async function getStateCache() {
  if (_redis) {
    try {
      const raw = await _redis.get(CACHE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn("sicbo_state_cache_read_failed", { reason: err?.message });
    }
  }
  return _memCache;
}

function resetForTests() {
  _memLeader = { owner: null, expiresAt: 0 };
  _memCache = null;
}

module.exports = {
  setRedisClient,
  nodeId,
  acquireOrRenewLeadership,
  releaseLeadership,
  setStateCache,
  getStateCache,
  resetForTests,
  LEADER_TTL_SEC,
};
