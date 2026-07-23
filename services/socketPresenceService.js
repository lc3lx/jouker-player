/**
 * Tracks how many live sockets a user currently has open against a given
 * table, across all game types. Used purely to avoid false-positive
 * disconnect handling (starting a reconnect/vacate timer) when a user closes
 * one of several open tabs/devices but is still connected via another.
 *
 * Redis-backed (multi-instance safe) when available, in-memory fallback
 * (correct for a single instance) otherwise — same shape as
 * pokerCollusionGuard's presence tracking.
 */
const TTL_SEC = 3600;

let redisClient = null;

function setRedisClient(client) {
  redisClient = client;
}

function countKey(tableId, userId) {
  return `table:socketcount:${String(tableId)}:${String(userId)}`;
}

/** In-memory fallback: Map<"tableId:userId", count> */
const memCounts = new Map();

/**
 * Call when a socket joins/subscribes to a table room. Returns the new count.
 */
async function registerSocket(tableId, userId) {
  const key = countKey(tableId, userId);
  if (redisClient) {
    const multi = redisClient.multi();
    multi.incr(key);
    multi.expire(key, TTL_SEC);
    const results = await multi.exec();
    return Array.isArray(results) ? Number(results[0]) || 1 : 1;
  }
  const next = (memCounts.get(key) || 0) + 1;
  memCounts.set(key, next);
  return next;
}

/**
 * Call when a socket for that table disconnects. Returns the remaining
 * count (0 or below means this was the user's last live socket for this
 * table — safe to run reconnect/vacate handling).
 */
async function releaseSocket(tableId, userId) {
  const key = countKey(tableId, userId);
  if (redisClient) {
    const next = await redisClient.decr(key);
    if (next <= 0) await redisClient.del(key);
    return next;
  }
  const prev = memCounts.get(key) || 0;
  const next = prev - 1;
  if (next <= 0) memCounts.delete(key);
  else memCounts.set(key, next);
  return next;
}

module.exports = {
  setRedisClient,
  registerSocket,
  releaseSocket,
};
