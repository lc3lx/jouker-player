/**
 * TimerManager - process-wide singleton scheduler backing all game timers.
 *
 * Single global tick loop (default 200ms resolution) instead of 1:1 native
 * timer wrapping. At 5000+ concurrent tables x 2-4 timers each, that's
 * 10,000-20,000 live native timers today; a single tick loop turns this into
 * one native timer for the whole process plus O(1) schedule/clear and a
 * cheap per-tick deadline scan. Trade-off: +/-tickMs timing precision instead
 * of exact - invisible for 30s turn timers and ~1s bot loops.
 *
 * `namespace` is expected to be a game's roomId, so `clearAll(roomId)`
 * replaces having to remember every individual clearInterval/clearTimeout
 * call site inside a game's destroy().
 */
class TimerManager {
  constructor(tickMs = 200) {
    this.tickMs = tickMs;
    this._timers = new Map(); // id -> { namespace, category, delayMs, repeat, callback, nextFireAt }
    this._nextId = 1;
    this._tickHandle = null;
  }

  _ensureTicking() {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => this._tick(), this.tickMs);
    if (typeof this._tickHandle.unref === "function") this._tickHandle.unref();
  }

  _tick() {
    if (this._timers.size === 0) return;
    const now = Date.now();
    for (const [id, entry] of this._timers) {
      if (now < entry.nextFireAt) continue;
      if (entry.repeat) {
        entry.nextFireAt = now + entry.delayMs;
      } else {
        this._timers.delete(id);
      }
      try {
        entry.callback();
      } catch (err) {
        // Never let one table's timer callback crash the global scheduler.
        // eslint-disable-next-line no-console
        console.error(
          `[TimerManager] timer callback error (namespace=${entry.namespace}, category=${entry.category}):`,
          err
        );
      }
    }
  }

  /**
   * Schedule a timer. Returns an opaque numeric id (not a native Timeout).
   * `category` is one of: turn | bot | reconnect | bot_fill | countdown | animation_delay
   * (free-form string this phase; not enforced).
   */
  schedule(namespace, category, delayMs, callback, { repeat = false } = {}) {
    const id = this._nextId++;
    this._timers.set(id, {
      namespace,
      category,
      delayMs,
      repeat,
      callback,
      nextFireAt: Date.now() + delayMs,
    });
    this._ensureTicking();
    return id;
  }

  /** Clear a single timer by id. Safe to call with null/undefined/already-cleared ids. */
  clear(timerId) {
    if (timerId == null) return false;
    return this._timers.delete(timerId);
  }

  /** Bulk-clear every timer registered under a namespace (roomId). Returns count cleared. */
  clearAll(namespace) {
    let cleared = 0;
    for (const [id, entry] of this._timers) {
      if (entry.namespace === namespace) {
        this._timers.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /** Diagnostic: total live timer count across all namespaces. */
  size() {
    return this._timers.size;
  }

  /** Diagnostic: live timer count for a single namespace. */
  sizeForNamespace(namespace) {
    let count = 0;
    for (const entry of this._timers.values()) {
      if (entry.namespace === namespace) count++;
    }
    return count;
  }
}

const timerManager = new TimerManager();
module.exports = timerManager;
module.exports.TimerManager = TimerManager;
