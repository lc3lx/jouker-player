/**
 * SpectatorService — in-memory spectator registry (process-wide).
 *
 * Spectators observe table state without being seated.
 * They receive public game_state events (no private cards) via the spec:<tableId> socket room.
 * Storage is memory-only; no Mongo persistence needed.
 */

/** @type {Map<string, Set<string>>} tableId → Set<userId> */
const spectators = new Map();

/** @type {Map<string, string>} userId → socketId */
const spectatorSockets = new Map();

/**
 * Register a spectator for a table.
 */
function add(tableId, userId, socketId) {
  const tid = String(tableId);
  const uid = String(userId);
  if (!spectators.has(tid)) spectators.set(tid, new Set());
  spectators.get(tid).add(uid);
  spectatorSockets.set(uid, String(socketId));
}

/**
 * Remove a spectator (on disconnect or stop_spectate).
 */
function remove(tableId, userId) {
  const tid = String(tableId);
  const uid = String(userId);
  const set = spectators.get(tid);
  if (set) {
    set.delete(uid);
    if (set.size === 0) spectators.delete(tid);
  }
  spectatorSockets.delete(uid);
}

/**
 * Number of current spectators for a table.
 */
function getCount(tableId) {
  return spectators.get(String(tableId))?.size ?? 0;
}

/**
 * Whether a user is currently spectating a table.
 */
function isSpectating(tableId, userId) {
  return spectators.get(String(tableId))?.has(String(userId)) ?? false;
}

/**
 * Socket IDs of all spectators for a table (for targeted emits).
 * @returns {string[]}
 */
function getSocketIds(tableId) {
  const set = spectators.get(String(tableId));
  if (!set || set.size === 0) return [];
  const ids = [];
  for (const uid of set) {
    const sid = spectatorSockets.get(uid);
    if (sid) ids.push(sid);
  }
  return ids;
}

/**
 * Clear all spectators for a table (called by GC on teardown).
 */
function clearTable(tableId) {
  const tid = String(tableId);
  const set = spectators.get(tid);
  if (set) {
    for (const uid of set) spectatorSockets.delete(uid);
    spectators.delete(tid);
  }
}

module.exports = {
  add,
  remove,
  getCount,
  isSpectating,
  getSocketIds,
  clearTable,
};
