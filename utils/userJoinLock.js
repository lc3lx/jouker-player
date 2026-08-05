const crypto = require("crypto");

const _chains = new Map(); // userId -> tail promise (never rejects)
let redisClient = null;
const LOCK_TTL_MS = Math.max(10_000, Number(process.env.USER_JOIN_LOCK_TTL_MS || 60_000));

function setRedisClient(client) {
  redisClient = client && typeof client.set === "function" ? client : null;
}

function keyFor(userId) {
  return `poker:join:user:${String(userId)}`;
}

async function releaseDistributedLock(key, token) {
  if (!redisClient) return;
  try {
    await redisClient.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0',
      { keys: [key], arguments: [token] }
    );
  } catch (_) {
    // The TTL is a safe fallback; never delete a lock we do not own.
  }
}

async function runWithDistributedLock(userId, fn) {
  if (!redisClient) return fn();
  const key = keyFor(userId);
  const token = crypto.randomUUID();
  const locked = await redisClient.set(key, token, { NX: true, PX: LOCK_TTL_MS });
  if (locked !== "OK") {
    const err = new Error("JOIN_IN_PROGRESS");
    err.code = "JOIN_IN_PROGRESS";
    throw err;
  }
  try {
    return await fn();
  } finally {
    await releaseDistributedLock(key, token);
  }
}

/**
 * Serializes same-user joins within a process and, when Redis is configured,
 * across API instances. This prevents two simultaneous join transactions from
 * seating/queueing the same wallet on different tables.
 */
async function withUserJoinLock(userId, fn) {
  const key = String(userId || "");
  if (!key) return fn();
  const previous = _chains.get(key) || Promise.resolve();
  const run = previous.then(
    () => runWithDistributedLock(key, fn),
    () => runWithDistributedLock(key, fn)
  );
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  _chains.set(key, tail);
  void tail.then(() => {
    if (_chains.get(key) === tail) _chains.delete(key);
  });
  return run;
}

module.exports = { withUserJoinLock, setRedisClient, _joinChainsForTest: _chains };
