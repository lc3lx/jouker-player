/**
 * King Arth — spin locks, nonces, free-spin sessions.
 * Uses Redis when setRedisClient() was called with a connected client; else in-memory Maps.
 */

const crypto = require("crypto");

const LOCK_TTL_MS = 45_000;
const FREE_SPIN_TTL_SEC = 7 * 24 * 3600;
const MAX_BANKED_FREE_SPINS = 50;
const FREE_SPINS_AWARD = 15;

/** @type {import('redis').RedisClientType | null} */
let redis = null;

function setRedisClient(client) {
  redis = client && typeof client.set === "function" ? client : null;
}

function keyLock(userId, tableId) {
  return `ka:lk:${String(userId)}:${String(tableId || "king-arth")}`;
}
function keyNonce(userId, tableId) {
  return `ka:nonce:${String(userId)}:${String(tableId || "king-arth")}`;
}
function keyFs(userId, tableId) {
  return `ka:fs:${String(userId)}:${String(tableId || "king-arth")}`;
}

const mem = {
  locks: new Map(),
  nonces: new Map(),
  fs: new Map(),
};

function stateKey(userId, tableId) {
  return `${String(userId)}\t${String(tableId || "king-arth")}`;
}

async function tryAcquireLock(userId, tableId) {
  if (redis) {
    try {
      const ok = await redis.set(keyLock(userId, tableId), "1", {
        PX: LOCK_TTL_MS,
        NX: true,
      });
      return !!ok;
    } catch {
      return memTryAcquireLock(userId, tableId);
    }
  }
  return memTryAcquireLock(userId, tableId);
}

function memTryAcquireLock(userId, tableId) {
  const k = stateKey(userId, tableId);
  const now = Date.now();
  const cur = mem.locks.get(k);
  if (cur && cur > now) return false;
  mem.locks.set(k, now + LOCK_TTL_MS);
  return true;
}

async function releaseLock(userId, tableId) {
  if (redis) {
    try {
      await redis.del(keyLock(userId, tableId));
      return;
    } catch {
      /* fall through */
    }
  }
  mem.locks.delete(stateKey(userId, tableId));
}

async function validateNonce(userId, tableId, nonceStr) {
  if (typeof nonceStr !== "string" || nonceStr.length === 0 || nonceStr.length > 32)
    return false;
  if (!/^\d+$/.test(nonceStr)) return false;
  let nonceBig;
  try {
    nonceBig = BigInt(nonceStr);
  } catch {
    return false;
  }
  if (nonceBig < 0n || nonceBig > BigInt("99999999999999999999999999999999")) return false;

  if (redis) {
    try {
      const script = `
        local k = KEYS[1]
        local n = ARGV[1]
        local cur = redis.call('GET', k)
        if cur and tonumber(cur) >= tonumber(n) then return 0 end
        redis.call('SET', k, n)
        return 1
      `;
      const r = await redis.eval(script, { keys: [keyNonce(userId, tableId)], arguments: [nonceStr] });
      return r === 1;
    } catch {
      return memValidateNonce(userId, tableId, nonceBig);
    }
  }
  return memValidateNonce(userId, tableId, nonceBig);
}

function memValidateNonce(userId, tableId, nonceBig) {
  const k = stateKey(userId, tableId);
  const prev = mem.nonces.get(k) ?? -1n;
  if (nonceBig <= prev) return false;
  mem.nonces.set(k, nonceBig);
  return true;
}

async function clearLocksForUser(userId) {
  const p = `ka:lk:${String(userId)}:`;
  if (redis) {
    try {
      if (typeof redis.scanIterator === "function") {
        for await (const k of redis.scanIterator({ MATCH: `${p}*`, COUNT: 50 })) {
          await redis.del(k);
        }
      } else {
        const keys = await redis.keys(`${p}*`);
        if (keys.length) await redis.del(keys);
      }
    } catch {
      /* ignore */
    }
  }
  const pref = `${String(userId)}\t`;
  for (const k of [...mem.locks.keys()]) {
    if (k.startsWith(pref)) mem.locks.delete(k);
  }
}

function capFsRemaining(n) {
  return Math.min(Math.max(0, n), MAX_BANKED_FREE_SPINS);
}

async function getFreeSpinSession(userId, tableId) {
  if (redis) {
    try {
      const raw = await redis.get(keyFs(userId, tableId));
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && o.remaining > 0 ? o : null;
    } catch {
      return memGetFs(userId, tableId);
    }
  }
  return memGetFs(userId, tableId);
}

function memGetFs(userId, tableId) {
  return mem.fs.get(stateKey(userId, tableId)) || null;
}

async function setFreeSpinSession(userId, tableId, session) {
  const capped = {
    ...session,
    remaining: capFsRemaining(session.remaining),
    totalMultiplier: Math.max(0, Number(session.totalMultiplier || 0)),
  };
  if (redis) {
    try {
      await redis.setEx(keyFs(userId, tableId), FREE_SPIN_TTL_SEC, JSON.stringify(capped));
      return;
    } catch {
      /* mem */
    }
  }
  mem.fs.set(stateKey(userId, tableId), capped);
}

async function deleteFreeSpinSession(userId, tableId) {
  if (redis) {
    try {
      await redis.del(keyFs(userId, tableId));
      return;
    } catch {
      /* mem */
    }
  }
  mem.fs.delete(stateKey(userId, tableId));
}

/**
 * @returns {Promise<object|null>}
 */
async function awardFreeSpins(
  userId,
  tableId,
  scatterCount,
  lockedBaseBet,
  lockedDoubleChance,
  totalMultiplier = 0
) {
  if (scatterCount < 4) return getFreeSpinSession(userId, tableId);
  const add = FREE_SPINS_AWARD;
  let cur = await getFreeSpinSession(userId, tableId);
  if (!cur || cur.remaining <= 0) {
    cur = {
      remaining: capFsRemaining(add),
      lockedBaseBet,
      lockedDoubleChance: !!lockedDoubleChance,
      totalMultiplier: Math.max(0, Number(totalMultiplier || 0)),
    };
  } else {
    cur.remaining = capFsRemaining(cur.remaining + add);
    cur.totalMultiplier = Math.max(
      0,
      Number(cur.totalMultiplier || totalMultiplier || 0)
    );
  }
  await setFreeSpinSession(userId, tableId, cur);
  return cur;
}

async function setFreeSpinTotalMultiplier(userId, tableId, totalMultiplier) {
  const cur = await getFreeSpinSession(userId, tableId);
  if (!cur || cur.remaining <= 0) return null;
  cur.totalMultiplier = Math.max(0, Number(totalMultiplier || 0));
  await setFreeSpinSession(userId, tableId, cur);
  return cur;
}

async function decrementFreeSpin(userId, tableId) {
  const cur = await getFreeSpinSession(userId, tableId);
  if (!cur || cur.remaining <= 0) return null;
  cur.remaining -= 1;
  if (cur.remaining <= 0) {
    await deleteFreeSpinSession(userId, tableId);
    return null;
  }
  await setFreeSpinSession(userId, tableId, cur);
  return cur;
}

async function peekFreeSpinRemaining(userId, tableId) {
  const cur = await getFreeSpinSession(userId, tableId);
  return cur?.remaining ?? 0;
}

module.exports = {
  LOCK_TTL_MS,
  MAX_BANKED_FREE_SPINS,
  FREE_SPINS_AWARD,
  setRedisClient,
  tryAcquireLock,
  releaseLock,
  validateNonce,
  clearLocksForUser,
  getFreeSpinSession,
  awardFreeSpins,
  setFreeSpinTotalMultiplier,
  decrementFreeSpin,
  peekFreeSpinRemaining,
  deleteFreeSpinSession,
  stateKey,
};
