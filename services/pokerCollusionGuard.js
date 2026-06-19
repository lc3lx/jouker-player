const Table = require("../models/tableModel");
const logger = require("../utils/logger");

let redisClient = null;

const TTL_SEC = Math.max(3600, parseInt(process.env.POKER_COLLUSION_TTL_SEC || "7200", 10));

function setRedisClient(client) {
  redisClient = client;
}

function presenceKey(tableId) {
  return `poker:presence:${String(tableId)}`;
}

function ipIndexKey(tableId, ip) {
  return `poker:presence:ip:${String(tableId)}:${String(ip)}`;
}

function deviceIndexKey(tableId, deviceId) {
  return `poker:presence:device:${String(tableId)}:${String(deviceId)}`;
}

function normalizeIp(ip) {
  if (!ip || typeof ip !== "string") return "unknown";
  return ip.split(",")[0].trim().slice(0, 64);
}

function normalizeDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string") return null;
  const d = deviceId.trim().slice(0, 128);
  return d.length >= 8 ? d : null;
}

/**
 * In-memory fallback when Redis unavailable.
 */
const memPresence = new Map();

function memGet(tableId) {
  if (!memPresence.has(tableId)) memPresence.set(tableId, new Map());
  return memPresence.get(tableId);
}

async function registerSeatPresence({ tableId, userId, ip, deviceId }) {
  const tid = String(tableId);
  const uid = String(userId);
  const nip = normalizeIp(ip);
  const did = normalizeDeviceId(deviceId);
  const payload = JSON.stringify({ ip: nip, deviceId: did, at: Date.now() });

  if (redisClient) {
    const multi = redisClient.multi();
    multi.hSet(presenceKey(tid), uid, payload);
    multi.expire(presenceKey(tid), TTL_SEC);
    if (nip && nip !== "unknown") {
      multi.sAdd(ipIndexKey(tid, nip), uid);
      multi.expire(ipIndexKey(tid, nip), TTL_SEC);
    }
    if (did) {
      multi.sAdd(deviceIndexKey(tid, did), uid);
      multi.expire(deviceIndexKey(tid, did), TTL_SEC);
    }
    await multi.exec();
    return;
  }

  memGet(tid).set(uid, { ip: nip, deviceId: did });
}

async function removeSeatPresence({ tableId, userId, ip, deviceId }) {
  const tid = String(tableId);
  const uid = String(userId);
  const nip = normalizeIp(ip);
  const did = normalizeDeviceId(deviceId);

  if (redisClient) {
    const multi = redisClient.multi();
    multi.hDel(presenceKey(tid), uid);
    if (nip && nip !== "unknown") multi.sRem(ipIndexKey(tid, nip), uid);
    if (did) multi.sRem(deviceIndexKey(tid, did), uid);
    await multi.exec();
    return;
  }

  memGet(tid).delete(uid);
}

/**
 * Reject if another seated player at same PUBLIC table shares IP or deviceId.
 * @throws Error with code COLLUSION_IP | COLLUSION_DEVICE
 */
async function assertNoCollusionAtPublicTable({
  tableId,
  userId,
  ip,
  deviceId,
  session,
}) {
  const table = await Table.findById(tableId)
    .select("isPrivate seats gameType")
    .session(session || null);
  if (!table) throw new Error("TABLE_NOT_FOUND");
  if (table.gameType !== "poker") return;
  if (table.isPrivate) return;

  const uid = String(userId);
  const nip = normalizeIp(ip);
  const did = normalizeDeviceId(deviceId);
  const seatedOthers = table.seats
    .map((s) => String(s.user))
    .filter((id) => id !== uid);

  if (redisClient) {
    if (nip && nip !== "unknown") {
      const ipMembers = await redisClient.sMembers(ipIndexKey(String(tableId), nip));
      const conflict = ipMembers.find((m) => m !== uid && seatedOthers.includes(m));
      if (conflict) {
        logger.warn("collusion_ip_blocked", { tableId, userId: uid, ip: nip, conflict });
        const err = new Error("COLLUSION_IP");
        err.code = "COLLUSION_IP";
        throw err;
      }
    }
    if (did) {
      const devMembers = await redisClient.sMembers(deviceIndexKey(String(tableId), did));
      const conflict = devMembers.find((m) => m !== uid && seatedOthers.includes(m));
      if (conflict) {
        logger.warn("collusion_device_blocked", { tableId, userId: uid, deviceId: did, conflict });
        const err = new Error("COLLUSION_DEVICE");
        err.code = "COLLUSION_DEVICE";
        throw err;
      }
    }
    return;
  }

  const present = memGet(String(tableId));
  for (const [otherId, meta] of present.entries()) {
    if (otherId === uid) continue;
    if (!seatedOthers.includes(otherId)) continue;
    if (nip && nip !== "unknown" && meta.ip === nip) {
      const err = new Error("COLLUSION_IP");
      err.code = "COLLUSION_IP";
      throw err;
    }
    if (did && meta.deviceId && meta.deviceId === did) {
      const err = new Error("COLLUSION_DEVICE");
      err.code = "COLLUSION_DEVICE";
      throw err;
    }
  }
}

module.exports = {
  setRedisClient,
  registerSeatPresence,
  removeSeatPresence,
  assertNoCollusionAtPublicTable,
  normalizeIp,
  normalizeDeviceId,
};
