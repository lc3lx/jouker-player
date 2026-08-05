/**
 * Idempotent per-socket presence for a seated user/table pair. A numeric INCR
 * leaks whenever the same socket emits join twice; a Set makes join/reconnect
 * safe and a short TTL bounds remnants after a process crash.
 */
const TTL_SEC = Math.max(60, Number(process.env.TABLE_SOCKET_PRESENCE_TTL_SEC || 3600));
const POKER_TTL_SEC = Math.max(30, Number(process.env.POKER_SOCKET_PRESENCE_TTL_SEC || 90));

let redisClient = null;

function setRedisClient(client) {
  redisClient = client;
}

function key(tableId, userId) {
  return `table:sockets:${String(tableId)}:${String(userId)}`;
}

const memSets = new Map();

function memSet(tableId, userId) {
  const k = key(tableId, userId);
  if (!memSets.has(k)) memSets.set(k, new Set());
  return memSets.get(k);
}

function socketMember(socketId) {
  if (!socketId) throw new Error("SOCKET_ID_REQUIRED");
  return String(socketId);
}

async function registerSocket(tableId, userId, socketId, options = {}) {
  const member = socketMember(socketId);
  const k = key(tableId, userId);
  const ttlSec = Math.max(30, Number(options.ttlSec || TTL_SEC));
  if (redisClient) {
    const multi = redisClient.multi();
    multi.sAdd(k, member);
    multi.expire(k, ttlSec);
    multi.sCard(k);
    const result = await multi.exec();
    return Number(result?.[2]) || 1;
  }
  const set = memSet(tableId, userId);
  set.add(member);
  return set.size;
}

async function touchSocket(tableId, userId, socketId, options = {}) {
  const member = socketMember(socketId);
  const k = key(tableId, userId);
  const ttlSec = Math.max(30, Number(options.ttlSec || TTL_SEC));
  if (redisClient) {
    const exists = await redisClient.sIsMember(k, member);
    if (!exists) return 0;
    await redisClient.expire(k, ttlSec);
    return Number(await redisClient.sCard(k)) || 0;
  }
  const set = memSets.get(k);
  return set?.has(member) ? set.size : 0;
}

async function releaseSocket(tableId, userId, socketId) {
  const member = socketMember(socketId);
  const k = key(tableId, userId);
  if (redisClient) {
    const multi = redisClient.multi();
    multi.sRem(k, member);
    multi.sCard(k);
    const result = await multi.exec();
    const remaining = Number(result?.[1]) || 0;
    if (remaining <= 0) await redisClient.del(k);
    return remaining;
  }
  const set = memSets.get(k);
  if (!set) return 0;
  set.delete(member);
  if (set.size === 0) memSets.delete(k);
  return set.size;
}

module.exports = {
  TTL_SEC,
  POKER_TTL_SEC,
  setRedisClient,
  registerSocket,
  touchSocket,
  releaseSocket,
};
