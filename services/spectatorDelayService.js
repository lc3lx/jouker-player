/**
 * Buffered spectator feed — delays public state snapshots to prevent ghosting.
 * Default delay: 30 seconds (configurable per table via env).
 */

const DEFAULT_DELAY_MS = Math.max(
  5000,
  parseInt(process.env.SPECTATOR_DELAY_MS || "30000", 10)
);

/** @type {Map<string, Array<{ deliverAt: number, payload: object }>>} */
const buffers = new Map();

function getDelayMs(tableId) {
  const perTable = process.env[`SPECTATOR_DELAY_MS_${String(tableId)}`];
  if (perTable) return Math.max(1000, parseInt(perTable, 10));
  return DEFAULT_DELAY_MS;
}

function enqueueSpectatorState(tableId, payload) {
  const tid = String(tableId);
  const delay = getDelayMs(tid);
  if (!buffers.has(tid)) buffers.set(tid, []);
  const q = buffers.get(tid);
  q.push({ deliverAt: Date.now() + delay, payload });
  if (q.length > 200) q.splice(0, q.length - 200);
}

function drainReadyStates(tableId, now = Date.now()) {
  const tid = String(tableId);
  const q = buffers.get(tid) || [];
  const ready = [];
  const pending = [];
  for (const item of q) {
    if (item.deliverAt <= now) ready.push(item.payload);
    else pending.push(item);
  }
  if (pending.length) buffers.set(tid, pending);
  else buffers.delete(tid);
  return ready;
}

function getLatestDelayedState(tableId) {
  const tid = String(tableId);
  const q = buffers.get(tid) || [];
  if (!q.length) return null;
  const now = Date.now();
  let best = null;
  for (const item of q) {
    if (item.deliverAt <= now) best = item.payload;
  }
  return best;
}

function clearTable(tableId) {
  buffers.delete(String(tableId));
}

module.exports = {
  DEFAULT_DELAY_MS,
  enqueueSpectatorState,
  drainReadyStates,
  getLatestDelayedState,
  clearTable,
  getDelayMs,
};
