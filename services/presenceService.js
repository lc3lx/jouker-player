const PRESENCE_STATUSES = [
  "online",
  "offline",
  "playing",
  "watching",
  "in_lobby",
  "busy",
  "idle",
  "reconnect_pending",
];

let redisClient = null;
const mem = new Map();
const TTL_SEC = Math.max(120, parseInt(process.env.PRESENCE_TTL_SEC || "300", 10));

function setRedisClient(client) {
  redisClient = client;
}

function key(userId) {
  return `presence:user:${String(userId)}`;
}

function normalizePresence(raw = {}) {
  return {
    userId: String(raw.userId || ""),
    status: PRESENCE_STATUSES.includes(raw.status) ? raw.status : "online",
    gameType: raw.gameType || null,
    tableId: raw.tableId ? String(raw.tableId) : null,
    lobbyId: raw.lobbyId ? String(raw.lobbyId) : null,
    watching: !!raw.watching,
    disconnected: !!raw.disconnected,
    reconnectPending: !!raw.reconnectPending,
    lastSeen: raw.lastSeen || Date.now(),
    meta: raw.meta || null,
  };
}

async function setPresence(userId, patch = {}) {
  const uid = String(userId);
  const prev = (await getPresence(uid)) || { userId: uid, status: "offline", lastSeen: Date.now() };
  const next = normalizePresence({ ...prev, ...patch, userId: uid, lastSeen: Date.now() });
  const payload = JSON.stringify(next);

  if (redisClient) {
    await redisClient.setEx(key(uid), TTL_SEC, payload);
  } else {
    mem.set(uid, next);
  }
  return next;
}

async function getPresence(userId) {
  const uid = String(userId);
  if (redisClient) {
    const raw = await redisClient.get(key(uid));
    if (!raw) return null;
    try {
      return normalizePresence(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return mem.get(uid) || null;
}

async function getPresenceBatch(userIds = []) {
  const out = {};
  for (const id of userIds) {
    out[String(id)] = await getPresence(id);
  }
  return out;
}

async function markOffline(userId) {
  return setPresence(userId, { status: "offline", disconnected: false, reconnectPending: false });
}

async function markPlaying(userId, { gameType, tableId }) {
  return setPresence(userId, {
    status: "playing",
    gameType: gameType || null,
    tableId: tableId || null,
    watching: false,
    disconnected: false,
    reconnectPending: false,
  });
}

async function markWatching(userId, { gameType, tableId }) {
  return setPresence(userId, {
    status: "watching",
    gameType: gameType || null,
    tableId: tableId || null,
    watching: true,
    disconnected: false,
  });
}

async function markLobby(userId, lobbyId) {
  return setPresence(userId, {
    status: "in_lobby",
    lobbyId: lobbyId || null,
    watching: false,
    tableId: null,
  });
}

async function markReconnectPending(userId, { gameType, tableId }) {
  return setPresence(userId, {
    status: "reconnect_pending",
    gameType: gameType || null,
    tableId: tableId || null,
    reconnectPending: true,
    disconnected: true,
  });
}

module.exports = {
  PRESENCE_STATUSES,
  setRedisClient,
  setPresence,
  getPresence,
  getPresenceBatch,
  markOffline,
  markPlaying,
  markWatching,
  markLobby,
  markReconnectPending,
};
