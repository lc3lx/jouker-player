/**
 * In-process per-user serialization for table joins.
 *
 * Closes the check-then-act (TOCTOU) window in `tableService.joinTable`: the
 * one-table gate (`findUserActiveTableAnywhere`) is a read, and the seat write
 * happens in a later, separate transaction. Two concurrent joins for the SAME
 * user (double-tap, or two devices firing together) can both pass the gate and
 * seat the user at two tables. Serializing a user's joins so join #2 only starts
 * after join #1 has fully settled (its seat committed) makes #2's gate observe
 * #1's seat and correctly reject with "already active at another table".
 *
 * Scope note: this serializes within a single API process. A cross-instance race
 * (two API nodes) is far rarer and is caught by the duplicate-seat health
 * monitor; a distributed lock can be layered on later if needed. Pure in-memory,
 * no Redis dependency, fail-safe (an error in one join never blocks the next).
 */
const _chains = new Map(); // userId -> tail promise (never rejects)

async function withUserJoinLock(userId, fn) {
  const key = String(userId || "");
  if (!key) return fn();
  const prev = _chains.get(key) || Promise.resolve();
  // Run fn only after the previous same-user join has fully settled (success OR
  // failure) — either way its seat write is committed before we read the gate.
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => {},
    () => {}
  ); // never-rejecting serialization link
  _chains.set(key, tail);
  // GC the map entry once this user is idle (no newer join queued behind us).
  void tail.then(() => {
    if (_chains.get(key) === tail) _chains.delete(key);
  });
  return run;
}

module.exports = { withUserJoinLock, _joinChainsForTest: _chains };
