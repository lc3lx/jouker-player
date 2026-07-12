/**
 * Redis ZSET FIFO waiting queue — O(log N) enqueue/rank/dequeue.
 * Key layout:
 *   poker:queue:z:{tableId}  — ZSET member=userId score=enqueueMs
 *   poker:queue:h:{tableId}  — HASH userId -> JSON { playerId, buyIn, queuedAt }
 */

let redisClient = null;

function queueZKey(tableId) {
  return `poker:queue:z:${String(tableId)}`;
}

function queueHKey(tableId) {
  return `poker:queue:h:${String(tableId)}`;
}

function setRedisClient(client) {
  redisClient = client;
}

function isEnabled() {
  return redisClient != null;
}

async function enqueue({ tableId, userId, playerId, buyIn }) {
  if (!redisClient) return null;
  const tid = String(tableId);
  const uid = String(userId);
  const zKey = queueZKey(tid);
  const hKey = queueHKey(tid);
  const now = Date.now();

  const existingRank = await redisClient.zRank(zKey, uid);
  if (existingRank != null) {
    return { position: existingRank + 1, alreadyQueued: true };
  }

  const multi = redisClient.multi();
  multi.zAdd(zKey, { score: now, value: uid });
  multi.hSet(
    hKey,
    uid,
    JSON.stringify({
      playerId: String(playerId),
      buyIn: Number(buyIn) || 0,
      queuedAt: now,
    })
  );
  await multi.exec();

  const rank = await redisClient.zRank(zKey, uid);
  return { position: rank != null ? rank + 1 : 1, alreadyQueued: false };
}

async function dequeueNext(tableId) {
  if (!redisClient) return null;
  const tid = String(tableId);
  const zKey = queueZKey(tid);
  const hKey = queueHKey(tid);

  const rows = await redisClient.zRangeWithScores(zKey, 0, 0);
  if (!rows || rows.length === 0) return null;

  const uid = String(rows[0].value);
  const rawMeta = await redisClient.hGet(hKey, uid);
  if (!rawMeta) {
    await redisClient.zRem(zKey, uid);
    return dequeueNext(tableId);
  }

  const multi = redisClient.multi();
  multi.zRem(zKey, uid);
  multi.hDel(hKey, uid);
  await multi.exec();

  let meta;
  try {
    meta = JSON.parse(rawMeta);
  } catch (_) {
    meta = { buyIn: 0, playerId: null, queuedAt: rows[0].score };
  }

  return {
    userId: uid,
    playerId: meta.playerId,
    buyIn: Number(meta.buyIn) || 0,
    queuedAt: meta.queuedAt || rows[0].score,
  };
}

async function getQueueEntry(tableId, userId) {
  if (!redisClient) return null;
  const raw = await redisClient.hGet(queueHKey(String(tableId)), String(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return { buyIn: 0, playerId: null };
  }
}

async function removeFromQueue(tableId, userId) {
  if (!redisClient) return false;
  const tid = String(tableId);
  const uid = String(userId);
  const multi = redisClient.multi();
  multi.zRem(queueZKey(tid), uid);
  multi.hDel(queueHKey(tid), uid);
  const results = await multi.exec();
  return Array.isArray(results) && results.some((r) => r > 0);
}

async function getPosition(tableId, userId) {
  if (!redisClient) return -1;
  const rank = await redisClient.zRank(queueZKey(String(tableId)), String(userId));
  return rank != null ? rank + 1 : -1;
}

async function getQueueLength(tableId) {
  if (!redisClient) return 0;
  return redisClient.zCard(queueZKey(String(tableId)));
}

async function clearQueue(tableId) {
  if (!redisClient) return;
  const tid = String(tableId);
  await redisClient.del([queueZKey(tid), queueHKey(tid)]);
}

async function isUserQueued(tableId, userId) {
  if (!redisClient) return false;
  const rank = await redisClient.zRank(queueZKey(String(tableId)), String(userId));
  return rank != null;
}

/** All queued entries in FIFO order — used for refunds before a queue is destroyed. */
async function listQueueEntries(tableId) {
  if (!redisClient) return [];
  const tid = String(tableId);
  const uids = await redisClient.zRange(queueZKey(tid), 0, -1);
  if (!uids || uids.length === 0) return [];
  const out = [];
  for (const uid of uids) {
    const raw = await redisClient.hGet(queueHKey(tid), String(uid));
    let meta = { buyIn: 0, playerId: null };
    if (raw) {
      try {
        meta = JSON.parse(raw);
      } catch (_) {
        // keep defaults
      }
    }
    out.push({ userId: String(uid), playerId: meta.playerId, buyIn: Number(meta.buyIn) || 0 });
  }
  return out;
}

module.exports = {
  setRedisClient,
  isEnabled,
  enqueue,
  dequeueNext,
  getQueueEntry,
  removeFromQueue,
  getPosition,
  getQueueLength,
  clearQueue,
  isUserQueued,
  listQueueEntries,
  queueZKey,
};
