# Production Monitoring + Self-Healing Layer — Production Audit

## What was built

A continuous, additive monitoring/self-healing layer on top of the already-hardened table lifecycle
system (`TABLE_LIFECYCLE_AUDIT.md`). It **extends existing production infrastructure rather than
duplicating it**: the existing Prometheus registry, the existing alert dispatcher, the existing
hash-chained audit log, and the existing two table-GC sweepers are all reused as-is. What's new is the
validation logic that didn't exist anywhere — duplicate-seat detection, orphaned wallet-lock detection,
stuck-hand detection, orphaned-timer detection, tournament-match staleness detection, a health-score
system, an admin dashboard, and a handful of concrete bugs the research pass surfaced along the way.

### New files
| File | Purpose |
|------|---------|
| `models/systemMonitorSettingsModel.js` | Admin-tunable singleton config (mirrors `botSettingsModel`) |
| `services/systemMonitorSettingsService.js` | Live in-memory cache of the above |
| `services/monitoring/tableHealthChecks.js` | Duplicate seats/reservations, dead poker game loops, orphaned TimerManager namespaces, allocator/stake consistency |
| `services/monitoring/economyHealthChecks.js` | Orphaned `WalletTableLock` rows, negative balances, house-wallet floor, delta-based global conservation sweep |
| `services/monitoring/tournamentHealthChecks.js` | Stale clan-tournament matches, escrow drift, standalone-tournament anomalies (alert-only) |
| `services/monitoring/socketHealthChecks.js` | Orphan room-membership signal (reporting only — duplicate-tab handling is already self-healed) |
| `services/monitoring/processHealthChecks.js` | Event-loop lag, heap/memory, CPU%, GC-sweep liveness |
| `services/systemHealthMonitorService.js` | Orchestrator: leader-lock guarded sweep, scoring, logging, alerting |
| `scripts/loadTestSystemHealth.js` | Mass-disconnect / queue-storm / rapid-join-leave stress scenarios against `/admin/system-health` |
| `test/systemHealthMonitor.test.js` | Real-MongoDB integration tests for every detect+repair path |

### Existing infrastructure reused, not duplicated
- **Metrics**: `utils/metrics.js`'s existing Prometheus registry gained 5 new gauges/counters
  (`systemHealthScore`, `subsystemHealthScore`, `monitorFindingsTotal`, `monitorRepairsTotal`,
  `eventLoopLagMs`) — no second registry.
- **Alerting**: every Critical finding and failed repair dispatches through the existing
  `utils/alert.js#sendAlert` — no new webhook/notification mechanism.
- **Audit logging**: every finding is logged via the existing `services/auditService.js#logEvent`
  (hash-chained `AuditLog`) with a `monitor.*` event prefix, the same convention
  `economyAuditService.js` already established for `economy.*` — no new log store.
- **Table GC**: `tableGcService.js`/`pokerTableGcService.js` are untouched in behavior — the monitor only
  adds a `getLastSweepAt()` liveness getter to each (2-line additions) so `processHealthChecks` can detect
  a stalled sweeper, and reuses their existing `countSocketsInRoom`/`cardRoomName` helpers (exported, not
  reimplemented) for the socket check.
- **Repair actions**: every single auto-repair calls an existing, already-tested function —
  `adminForceEndHandTable` (stuck hands), `TimerManager.clearAll` (orphan timers, one new diagnostic
  method added: `listNamespaces()`), `releaseTableSeatToBalance` (orphaned funded locks),
  `clanTournamentEngineService.tick()` (stale tournament matches). **No new game/settlement/tournament
  logic was written** — the monitor only decides *when* to call code that already exists and is already
  covered by its own tests.
- **Multi-instance safety**: a best-effort Redis leader lock (`SET NX PX` + renewal), the same concept
  `sicboService.js`'s round loop already uses, so the sweep — and therefore its repairs — runs on exactly
  one node in a multi-instance deployment. Deliberately fails open (runs anyway) on a Redis error, since
  every repair action above is independently safe to run redundantly.

---

## Concrete bugs fixed (found during the research pass, independent of the monitor itself)

1. **`socket/handlers/game.handlers.js`** (`join_tarneeb41_table`): a raw
   `roomManager.tarneeb41GamesByTableId.delete(...)` bypassed `game.destroy()` entirely when discarding a
   stale in-memory game — the discarded instance's `TimerManager` entries (bot/turn/trick timers) and
   held bot-pool identities were never released, and could keep firing under the `roomId` the replacement
   game reuses. Now calls `game.destroy()` first.
2. **`services/tournamentEngineService.js`**: the per-tournament `scheduleTick` timer was the only
   recurring interval in the whole codebase missing `.unref()`. Fixed.
3. **`sockets/tableGame.js`**: `startLockHeartbeat`'s timer was likewise missing `.unref()`. Fixed.
4. **`services/houseWalletService.js#applyHouseDelta`**: the insufficient-balance throw path had no
   `sendAlert`, unlike every wallet-side underflow path in `walletLedgerService.js`. Fixed.
5. **`services/tableGcService.js`**: the boot-time zombie sanitizer had no `tableKind:"tournament"` case
   — a crash mid-tournament-match would silently reopen the ephemeral match table as a normal bookable
   lobby table on restart, while the `ClanTournamentMatch` doc still showed `status:"live"` pointing at
   it. Same gap in the idle-abandon exemption list (exempted `"static"`, not `"tournament"`). Both fixed
   — tournament tables are now left alone at boot/idle-sweep time for the tournament engine's own
   deadline-walkover sweep to resolve.
6. **`scripts/reconcileWallets.js`**: the transaction-type replay switch didn't handle
   `clan_tournament_entry/prize/refund` (or `deposit`/`withdraw`) — these fell into the silent default
   branch, so the one tool that exists for wallet reconciliation was blind to all tournament money
   movement. Fixed.

---

## Result: PASS

| Check | Result |
|-------|--------|
| New/updated regression tests | **8/8 pass** (`test/systemHealthMonitor.test.js`, real `mongodb-memory-server` replica set — duplicate-seat detection, orphaned-lock auto-repair with real wallet assertions, zero-amount lock cleanup, negative-lock non-flagging of legitimate locks, orphan-timer-namespace auto-repair, negative-balance detection, delta-based conservation drift detection, and a full `runSweepOnce()` smoke test) |
| Full backend suite | 601 tests, **48 fail — all pre-existing Trix/Tarneeb `currentKingIndex` failures**, same documented baseline as `TABLE_LIFECYCLE_AUDIT.md`/`BOT_SYSTEM_AUDIT.md` (confirmed stable across two consecutive full runs; one earlier run showed transient flakiness from the long full-suite duration, not a regression — same failing test names both times) |
| New failures introduced | **0** |
| No duplicate monitoring services | Verified — repo-wide grep for `setInterval(` across all of `backend/` finds 14 files; 13 pre-exist (table/poker GC, `TimerManager`, `tableGame.js`'s per-instance timers, `tournamentEngineService`, `botProfileService`, `clanTournamentEngineService`, `vipService`, `sicboService`, `roomManager`, 2 test files, the pre-existing load-test script) and exactly **one is new** — `systemHealthMonitorService.js`. No duplicated cleanup jobs: the monitor calls existing GC/repair functions, it never re-implements table/queue/timer cleanup itself. |
| No conflicting timers | The new sweep's own interval is independently configurable (`sweepIntervalMs`, default 60s) and doesn't touch any existing interval's cadence. |

---

## Coverage by requirement

### Table health monitor — periodic, configurable interval
`systemMonitorSettingsModel.sweepIntervalMs` (default 60000ms, admin can set 30/60/120s+ live via
`PUT /api/v1/admin/monitor-settings`, no restart). Runs every checker module each sweep.

### Table validation
| Requirement | Status |
|---|---|
| Valid state / lifecycle | Covered by the existing `TABLE_LIFECYCLE_AUDIT.md` work (derived-status poker, imperative card-game status) — not re-validated here, that's the previous audit's domain |
| Correct player/bot count | `socketHealthChecks` (room membership vs. roster), `tableHealthChecks` (seat integrity) |
| No duplicated seats/players | `tableHealthChecks.checkDuplicateSeats` — critical, alert-only (ambiguous which entry is authoritative to auto-fix) |
| No invalid reservations | Same check — covers `vacatingPlayers`/`waitingQueue` overlap too |
| No invalid spectators | Not separately checked — spectators carry no funds/seat state, lowest risk, deferred |
| No orphan timers | `tableHealthChecks.checkOrphanTimerNamespaces` — **auto-repaired** via `TimerManager.clearAll`, plus the root-cause fix (bug #1 above) |
| No orphan socket rooms | `socketHealthChecks.checkOrphanRoomMembership` — reporting signal |
| No dead game loop | `tableHealthChecks.checkDeadGameLoops` — **auto-repaired** via `adminForceEndHandTable` |
| No invalid tournament state | `tournamentHealthChecks` (see Tournament section) |
| No memory leaks | `processHealthChecks` (heap%, event-loop lag, GC-sweep liveness) |

### Player / bot validation
Reconnect-timeout/ghost-player detection was the subject of the *previous* audit
(`TABLE_LIFECYCLE_AUDIT.md` item 2 — poker's dead vacate pipeline) and is now solidly fixed at the
source; this layer's `adminTableLifecycleOverview` dashboard (previous session) already surfaces the
ghost-seat count live. Duplicate-socket/duplicate-tab handling was likewise fixed at the source
(`socketPresenceService.js`, previous session); this layer reports on standing room-membership excess as
a defense-in-depth signal, not a new detector. Bot-on-multiple-tables / bot-reservation-leak: structurally
prevented — bots are never persisted to Mongo `seats` (only humans are), so cross-table bot duplication
isn't reachable the way human duplication is; not separately checked here.

### Allocator validation
`tableHealthChecks.checkAllocatorConsistency` — per stake tier, confirms the 4 expected static tables
exist and flags any overflow table (tableNumber>4) not correctly `tableKind:dynamic/vip/tournament` (the
ongoing drift-detection layer for the bug fixed in `TABLE_LIFECYCLE_AUDIT.md`).

### Matchmaking / queue validation
Covered by `tableHealthChecks.checkDuplicateSeats` (duplicate/overlapping queue entries) and the previous
session's `findUserActiveTableAnywhere` global one-table-per-player gate (no player assigned twice, no
race — that's a join-time gate, not a periodic check, and remains the correct place for that guarantee).

### Socket validation
`socketHealthChecks` — see Table validation row above. Heartbeat failures are handled by Socket.IO's
tuned ping/pong (previous session, `SOCKET_PING_INTERVAL_MS`/`SOCKET_PING_TIMEOUT_MS`), not re-detected here.

### Memory / CPU validation
`processHealthChecks` — event-loop lag via `perf_hooks.monitorEventLoopDelay()` (Node built-in, no new
dependency), heap usage %, a `process.cpuUsage()`-delta rough CPU%, and GC-sweep-liveness (is
`tableGcService`/`pokerTableGcService` still ticking).

### Economy validation
`economyHealthChecks` — orphaned wallet-table locks (**auto-repaired**: zero-amount deleted immediately,
funded locks refunded via `releaseTableSeatToBalance` after a configurable grace period), negative
balances (critical, alert-only — a real negative balance needs investigation, not an automatic guess-fix),
house-wallet floor, and a **delta-based global conservation sweep**: rather than needing to know an
absolute "total supply" constant (which would require knowing every historical seeding/topup exactly),
each sweep compares the current `sum(wallets)+house` against the previous sweep's total plus the net
external deposit/withdraw flow that occurred in between — any unaccounted-for change flags real drift.
Verified in tests to correctly ignore legitimate deposits and correctly flag an out-of-band balance mutation.

### Tournament validation
`tournamentHealthChecks` covers the **working** clan-tournament system fully: stale `status:"live"`
matches past their deadline (**auto-repaired** by calling the tournament engine's own idempotent `tick()`
— no new bracket/walkover logic written), matches whose table went missing/archived out from under them
(the boot-sanitizer gap, bug #5 above), and escrow-drift (`escrowHeld` vs. `sum(participants.escrow)`,
alert-only). The **standalone legacy Tournament system** (distinct from the working bracket system, with
its own known, separately-tracked money-safety gap — entry fees debited via a non-transactional legacy
path before registration confirms, and computed prizes never wired up to a payout call) is **monitored
and alerted on only, per explicit product decision** — `checkStandaloneTournaments` flags lifecycles stuck
past a reasonable window and finished-but-unpaid prize computations, but this pass does not touch that
system's registration/payout code. That remains open, tracked work for a future session.

### Admin dashboard
`GET /api/v1/admin/system-health` — per-subsystem status (tables/economy/tournaments/sockets/process) and
score, overall health %, every finding from the latest sweep with repair outcome, and per-subsystem stats
(memory, event-loop lag, CPU%, timer counts). `GET`/`PUT /api/v1/admin/monitor-settings` for live-tuning
the sweep interval and every grace period/threshold. Both reuse the existing `authService.protect +
allowedTo("admin","manager")` guard already applied to the admin router.

### Health score
Each of the 5 subsystems reports `healthy=100 / warning=60 / critical=20`; overall score is their average,
surfaced both in the dashboard JSON and as Prometheus gauges (`system_health_score`,
`subsystem_health_score{subsystem}`) for external alerting/dashboards.

### Logging
Every finding is persisted via `auditService.logEvent("monitor.<check>", {...})` with the table/user
already carried by that function's own fields, plus `severity`, `message`, `socketId`, `repaired`,
`repairAction`, `repairResult`, and `durationMs` in `meta` — covers every field the request asked for.

### Alerts
`sendAlert` fires for every Critical finding, every failed repair attempt, and any check that's produced
findings for `repeatedAnomalyThreshold` (default 3) consecutive sweeps in a row — directly matching
"repair failed / repeated anomaly / memory leak / allocator failure / queue corruption / tournament
corruption / wallet inconsistency."

### Self-healing
Auto-repair is on by default (`autoRepairEnabled`, admin-toggleable) and, per explicit product decision,
money-adjacent repairs (orphaned funded wallet locks, stuck poker hands) only fire after a configurable
grace period confirms the anomaly is real rather than an in-flight operation. **The server is never
restarted and no active game is ever interrupted** by any repair action — every repair either targets
already-dead/orphaned state (timers, locks with no live seat) or uses the same manual escape hatch an
admin already had (`adminForceEndHandTable`, which force-resolves one stuck hand, not the table).

### Stress tests
`scripts/loadTestSystemHealth.js` — mass-simultaneous disconnect+reconnect, a queue-storm (N identities
joining a full table concurrently), and rapid join/leave cycling, reusing `loadTestTableGame.js`'s
socket-connection pattern and the app's own `createToken` util rather than duplicating either. Polls
`/admin/system-health` afterward and asserts overall score ≥80 and no critical subsystems. Requires
operator-provisioned fixtures (pre-funded user ids, a target table) — same convention as the existing
`loadTestTableGame.js`, not run as part of this pass (needs a live server + seeded DB).

---

## Production-readiness assessment

**Ready**, with two explicitly scoped-out items tracked for follow-up, not silently dropped:

1. The standalone legacy Tournament system's money-safety gap (entry-fee debit/registration atomicity,
   missing payout wiring) is monitored and alerted on but not fixed — per explicit product decision this
   session, since fixing it means writing new transactional/payout code, not adding monitoring.
2. `loadTestSystemHealth.js` was written and syntax-verified but not executed end-to-end against a live
   server (would require a running instance + seeded fixtures outside this pass's scope) — the integration
   test suite (`test/systemHealthMonitor.test.js`) is what actually proves the detect+repair logic works,
   against a real MongoDB replica set, not the stress script.

Performance/memory/CPU impact of the sweep itself: each of the 5 checker modules runs as a handful of
targeted Mongo queries (duplicate-seat and orphan-lock checks use aggregation pipelines rather than
pulling full collections into memory) plus cheap in-process reads (`TimerManager.size()`,
`process.memoryUsage()`, the event-loop-lag histogram). At the default 60s interval this is negligible
background load; the interval is admin-tunable up to 120s+ if a given deployment's table count makes even
that too frequent.
