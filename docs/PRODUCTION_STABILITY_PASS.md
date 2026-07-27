# Production Stability & Lifecycle Pass — Poker / Trix / Tarneeb41

Follow-up to `PRODUCTION_LIFECYCLE_REPAIR_AUDIT.md`. Scope: the three table games only. No
economy/wallet/settlement/protocol/API/payload changes. Approach (confirmed): **harden guaranteed
exits + widen the existing self-healing** (no FSM rewrite), delivered in priority phases with staging
verification. Money paths are not testable on the Mongo-less dev box → engine-independent unit tests
here + a staging matrix below.

---

## 1. Root causes found (three read-only audits)

### Session / leave / one-table
- **Zombie seat (HIGH, fixed):** `socket.isSpectator` was set on watch and **never reset**, so a user
  who watched then took a seat had their disconnect short-circuited past `releaseSocket` +
  `onPlayerSocketDisconnected` → seat + locked buy-in leaked permanently. *This is the reported
  spectate→sit→stuck.*
- **Two-table race (HIGH, fixed):** the one-table gate is a read; the seat write is a separate txn →
  concurrent joins (double-tap / two devices) could seat one user at two tables.
- **Stale vacating lock (fixed earlier):** expired `vacatingPlayers` rows counted as "active" forever;
  now filtered by `vacateUntil`.

### Poker freeze / deadlock (server-owned progression)
- **F1 (HIGH, fixed):** a stuck **bot** turn was invisible to the watchdog — bots got
  `actionDeadline=null` and `playBotTurn`'s timer callback was un-`catch`-ed → swallowed throw +
  `running=true` with a stale timer handle.
- **F2 (HIGH, fixed):** `broadcastState` awaited the **unguarded** `saveSnapshot` → a Redis blip
  rejected into `advance()` and froze the live table.
- **F3 (MED-HIGH, fixed):** a throw in `startHand` stranded `running=true` (the `finally` only reset
  `starting`) → watchdog-blind.
- **F4/F5 (MED, mitigated):** chip-conservation / settlement freezes had **no watchdog at all**
  (`checkDeadGameLoops` skips `!running`) and no admin recovery.
- **F7 (LOW-MED, deferred):** `advance()` runs before `splice()` on vacate → a turn-skip (not a freeze);
  reordering the live-pot flow is delicate + untestable, so documented rather than risked.

### State model / monitoring
- **SITTING_OUT dead-end (fixed):** a disconnect-timeout seat kept `disconnectedAt`, so bot-fill
  promotion skipped it forever (test-table branch).
- **Watchdog gaps (fixed):** no frozen-table detector; no card-game stuck detector; no seat-without-
  socket detector.
- **Verified sound (no change):** Trix human→bot syncs both rosters; Tarneeb `round_end` has 3 exits;
  socket/timer/listener cleanup (backend + all 3 Flutter controllers); FSM mirror is telemetry-only.
- **Cosmetic dead code (documented, not touched to avoid diff-risk in a 5000-line money file):**
  unused `markActiveHandParticipants` import; unreachable `cardTableVacateService` fallback (both
  engines define `convertHumanToBot`); `poker_service.dart` anonymous-listener latent guard.

---

## 2. Files changed + why

| File | Change | Root cause |
|---|---|---|
| `sockets/tableGame.js` | reset `socket.isSpectator` on seat-join; disconnect falls through to the seat path | zombie seat |
| `sockets/tableGame.js` | bot turns get a real `actionDeadline`; timer handle nulled on fire; `playBotTurn` `.catch` | F1 |
| `sockets/tableGame.js` | `saveSnapshot` Redis write wrapped in try/catch | F2 |
| `sockets/tableGame.js` | `startIfReady` `catch` → `running=false` + heal round to idle | F3 |
| `sockets/tableGame.js` | clear `disconnectedAt`/`reconnectDeadline` when setting `SITTING_OUT` | dead-end |
| `utils/userJoinLock.js` (new) + `services/tableService.js` | per-user in-process join mutex wraps `joinTable` | two-table race |
| `services/monitoring/tableHealthChecks.js` | `checkFrozenTables` (probe-repair + admin alert) + `checkStuckCardGames` | F4/F5, card game_end |
| `services/monitoring/socketHealthChecks.js` | `checkSeatWithoutSocket` detector | zombie detection |
| *(earlier this session)* `cardTableVacateService.js`, `tableAllocationService.js` | expired-vacate filter + `purgeVacatingEntry` | stale one-table lock |

**Unchanged on purpose:** all settlement/wallet math; the reconnect grace on *disconnect* (a game
rule — only the Leave button is immediate); F7 vacate ordering (deferred).

---

## 3. Production-readiness

**Backend node tests: 20/20 green** (`lifecycle.repair.test.js` incl. 3 new join-mutex tests +
`poker.table-game-bridge.test.js`); `node -c` clean on every edited file; no new analyzer issues.

**Event-driven confirmation:** poker progression is 100% server-owned (native timers for *rules*:
action timeout, bot think, next-hand schedule; none gate on a client ack). Card games advance via the
engine + server-owned round_end timer. Frontend timers are display/recovery only (Step-8 audit).
Timers kept are exactly the necessary ones per the engineering note; none drive game-state *decisions*.

**Verdict: the reported production defects (spectate→sit zombie, stale one-table lock) are fixed at the
source, and the highest-risk poker freeze paths now have guaranteed exits + watchdog coverage.**
Pending the staging matrix + a Mongo-enabled fault-injection run before ship.

---

## 4. Remaining risks
- **Money paths untested locally.** Each change is a small guard/reuse of a proven primitive, but the
  join-mutex + poker guards must be staging-verified.
- **F7 turn-skip** (vacate `advance`-before-`splice`) left as-is — a fairness edge, not a freeze.
- **Chip-conservation freeze** has no *safe* auto-recovery by design; the new detector alerts for admin
  DB reconcile (auto-unfreezing an imbalanced table would be worse).
- **Cross-instance** two-table race: the mutex is per-process; a two-API-node race stays rare and
  duplicate-seat-monitor-detected (add a Redis lock later if needed).

---

## 5. Staging chaos / stress / concurrency matrix (run against staging)
Assert after each: **no zombie seat, no two-table seating, no frozen-with-no-exit, chip conservation,
revision monotonic.**

| Scenario | Expected |
|---|---|
| Spectate poker → take seat → kill app | seat enters reconnect grace → bot; no permanent ghost |
| Two fast joins to different tables (2 devices) | one succeeds, other 409 "already active" |
| Disconnect during your turn | fold-on-timeout or reconnect within window; hand advances |
| Disconnect during settlement | deferred cash-out completes; seat frees |
| Leave during deal / animation | leaves immediately; hand continues for others |
| Bot wedged (inject throw in playBotTurn) | `poker_bot_turn_failed` logged; watchdog force-ends within grace |
| Redis blip during broadcast | `poker_snapshot_save_failed` logged; table keeps playing |
| Throw during startHand | `poker_start_hand_failed`; table returns to idle, restarts |
| Force chip-conservation freeze | `frozen_table` critical alert; probe attempt; admin reconcile path |
| Kill process / restart backend | snapshot restore + reconcile; table resumes correctly |
| Background 10 min / 10 h | reconnect or clean vacate; no zombie |
| Mongo failover / Redis reconnect / high latency / packet loss | no freeze; recovery via existing paths |
| Spam join / spam leave | idempotent; one seat; no stuck lock |

Existing runnable harness: `scripts/chaos/lifecycle-chaos.js`, `scripts/bench/lifecycle-benchmark.js`
(env-driven). Unstick tool: `scripts/unstickPlayer.js [--apply] [--force]`.

Auto-repair the monitor now covers: dead poker loop, **frozen poker table (new)**, orphan timers,
duplicate seats (alert), **seat-without-socket (new, alert)**, **stuck card game_end (new, alert)**,
allocator drift.
