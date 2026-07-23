# Table Lifecycle / Matchmaking / Bot System — Production Audit

## What was built

The existing table architecture (`tableFactory` / `tableAllocator` / `tableManager` for creation,
per-game GC services, the Trix/Tarneeb41 disconnect→bot-vacate pipeline) was **audited and hardened,
not redesigned**. Three parallel research passes over the full backend (table lifecycle/GC,
reconnect/heartbeat/ghost handling, join-concurrency/bot-replacement) found one critical bug matching
exactly the scenario called out in the request, three more critical gaps, and eight secondary hardening
items. All are fixed below, additively, reusing existing services and patterns (`withMongoTransaction`,
`tableFactory`, `pokerVacateService`, `cardTableVacateService`, the `BotSettings` admin-singleton
pattern). No public method names, socket event names, or payload shapes were renamed.

---

## Result: PASS

| Check | Result |
|-------|--------|
| New/updated regression tests | **18 / 18 pass** (`table.audit-fixes.test.js` — 10; `poker.gameplay-e2e.test.js` — 3 new + 2 rewritten to match the corrected architecture) |
| Full backend suite | 593 tests, **48 fail — all pre-existing Trix/Tarneeb `currentKingIndex` failures** (same baseline documented in `BOT_SYSTEM_AUDIT.md`) |
| New failures introduced | **0** |
| Every edited/new file | load-checked individually (`node -e "require(...)"` / `node --check`) — no syntax or require-cycle errors |

---

## PASS / FAIL by requirement

### 1. One table per player — **FIXED (was FAIL)**

- **Before:** `findUserSeatedTable` (`services/tableAllocationService.js`) only checked the *same*
  `gameType + tier` as the table being joined. A user could hold simultaneous seats across every other
  lane (poker beginner + poker beast + trix + tarneeb41), each with its own locked buy-in.
- **Fix:** new `findUserActiveTableAnywhere(userId, excludeTableId)`
  (`services/tableAllocationService.js`) checks Mongo `seats`, `vacatingPlayers` (poker grace window),
  and `waitingQueue` across **every** table, plus a new Redis reverse-index
  (`poker:queue:user:{userId}` in `utils/redis/pokerQueueRedis.js`, `getQueuedTableForUser`) for
  poker's Redis-backed queue, which has no Mongo footprint to scan. Wired into the single seat/queue
  allocation choke point, `tableService.joinTable`, before the reconnect-anchor branches so reconnecting
  to a table the user already occupies still works. Rejects with `409 "You are already active at
  another table"` otherwise.
- **Tests:** `findUserActiveTableAnywhere finds a seat in a different gameType/tier`,
  `...returns null when nothing matches anywhere`.

### 2. Reconnect logic — **FIXED (was FAIL for poker; already correct for Trix/Tarneeb41)**

- **Before (the headline bug):** `services/pokerVacateService.js`'s full disconnect→30s-grace→bot-takeover
  pipeline (`vacatePokerSeat` → `finalizeVacateWithBot`, engine-wired via `applyEngineVacate`/
  `onVacateExpired` in `sockets/tableGame.js`) was completely built and unit-tested, but **never called
  from any route or socket handler**. The actual disconnect path
  (`TableGame.onPlayerSocketDisconnected`) only set the seat to `SITTING_OUT` after the 90s reconnect
  window and stopped — forever. This is precisely "a player disconnects, returns hours later, the same
  table is still running with bots" — except worse: the seat never even became a bot, it just sat as a
  permanent ghost with the buy-in locked.
- **Fix:** `onPlayerSocketDisconnected`'s reconnect-timeout callback (`sockets/tableGame.js`) now calls
  `vacatePokerSeat({ tableId, userId, reason: "disconnect_timeout" })` instead of manually setting
  `SITTING_OUT`. This reuses the already-built, already-tested pipeline unchanged: Mongo seat →
  `vacatingPlayers` with a fresh grace window → engine-side `applyEngineVacate` (folds/advances the
  in-progress hand) → 30s later, `onVacateExpired` → `finalizeVacateWithBot` forfeits the locked buy-in
  and seats a bot. Also closed a parity gap: poker's socket reconnect handler
  (`handleJoinTable`/`join_table`) now calls `tryRestoreVacatedSeat` on rejoin (previously only the REST
  `POST /join` endpoint did), matching how Trix's `join_trix_table` handler already restores/finalizes on
  reconnect.
- **Trix/Tarneeb41:** confirmed already correct — `cardTableVacateService.scheduleCardTableVacate` /
  `finalizeCardTableVacate` handle both disconnect and explicit `leave_room` through one shared path,
  already wired.
- **Tests:** `VACATE PIPELINE: vacatePokerSeat moves the seat to vacatingPlayers; reconnecting within
  the window restores it exactly`, `VACATE PIPELINE: an expired vacate window forfeits the wallet lock
  instead of leaving it stuck forever`, `WIRING: the reconnect-window timeout hands the seat to
  vacatePokerSeat instead of parking it at SITTING_OUT forever` — the wiring test proves the timeout
  callback actually fires the pipeline; the two pipeline tests run against a real MongoDB replica set
  (`mongodb-memory-server`) and assert real `WalletTableLock`/`Wallet` state, not mocks.

### 3. Reconnect timeouts, admin-configurable — **FIXED (was env-only, not live)**

- **Before:** timeouts existed and were per-game-different (poker 90s reconnect / 30s vacate, tarneeb41
  60s, trix 30s) but only configurable via env var + process restart.
- **Fix:** new `models/tableLifecycleSettingsModel.js` singleton (mirrors the existing
  `botSettingsModel.js` pattern exactly: `key:"default"`, `getDefaults()`, env-derived schema defaults)
  and `services/tableLifecycleSettingsService.js` (in-memory cache, same shape as
  `botBehaviorService.js`'s `_settings`/`applySettings`/`getSettings`). Hot paths
  (`onPlayerSocketDisconnected`, `pokerVacateService.vacateUntilDate`, `applyEngineVacate`'s fallback
  deadline, `cardTableVacateService.vacateMsFor`) now read the live cache instead of the frozen
  module-load constant, so an admin update applies to every *new* timer immediately, no restart. Loaded
  from DB at boot (`server.js`). Admin routes: `GET/PUT /api/v1/admin/table-lifecycle-settings`.
  GC-interval fields are present in the schema/dashboard for visibility but intentionally **not**
  live-rewired in this pass — those drive `setInterval` timers set up once at boot, and restarting them
  live is a separate, higher-risk change than swapping a value read at the moment a timer is armed; noted
  here as a deliberate scope boundary, not an oversight.

### 4. When last human leaves — **PASS (already correct, verified, not a gap)**

Contrary to the scenario hypothesized in the request, this was already solidly guarded, independently for
both game families:

- **Poker:** `startIfReady`/`beginNextHandIfPossible` hard-gate on human presence
  (`eligibleHumanCount() >= POKER_MIN_PLAYERS` or `humanSeatCount() >= 1` with bot-fill) — a hand cannot
  start with zero humans. `removeLiveHumanSeat` explicitly tears down the table (clears bots, pot, timers)
  the instant `humanSeatCount() < 1`.
- **Trix/Tarneeb41:** `abandonCardTableIfNoHumans` → `abandonTrixTableIfNoHumans` /
  `abandonTarneeb41IfNoHumans` refund remaining seats and clear the in-memory game as soon as
  `humanCount() === 0`, invoked from both the vacate-finalize path and the idle-sweep GC.

The dead vacate pipeline (item 2 above) is a distinct bug — a single ghost seat among otherwise-active
players, not an all-bots table running forever.

### 5. Table lifecycle states — **FIXED (archival bug) + documented**

- **Before:** `rooms/roomManager.js`'s `clearTrixGame`/`clearTarneeb41Game` called
  `archiveTableDocument` (→ `status:"archived"`, lobby-hidden) unconditionally on **every** normal
  game-completion path, with no `tableKind` check. Since the only code that ever reopened an archived
  static table was the one-shot boot sanitizer, the "4 permanent static tables per tier" design degraded
  at runtime into an ever-shrinking pool silently backfilled by dynamic tables — every finished hand at a
  fixed table made it vanish from the lobby until the next server restart. Poker already had this right
  (`pokerTableGcService` resets static tables to `"waiting"` instead of archiving).
- **Fix:** `tableLifecycleService.archiveTableDocument` now checks `tableKind` first; `"static"` tables
  are **reset** (`status` → `"open"`/`"waiting"`, seats/queue/settlement-lock cleared) instead of
  archived. Tournament/VIP-destroy archival is unaffected (verified by a dedicated test).
- **States confirmed as-is (no bug):** poker uses a derived-status function (`derivePokerTableStatus`)
  recomputed at every mutation; card games use imperative status strings (`open`/`playing`/`archived`).
  Two different but each internally-consistent models — not unified in this pass (would be an
  architecture change, out of scope for "fix and extend").
- **Tests:** `archiveTableDocument resets (never archives) a static table`,
  `archiveTableDocument still archives non-static (tournament) tables`.

### 6. Table auto-creation on full — **FIXED (mismarking bug) + confirmed reactive-by-design**

- **Before (critical):** `pokerTableAllocationService.findAvailablePokerTable`'s create-on-miss branch
  called `Table.create()` directly, bypassing `tableFactory` (which documents itself as the sole
  creation entrypoint) and never setting `tableKind` — so it silently defaulted to `"static"`. Every
  poker table created above the 4 fixed static tables per tier/stake became a permanent, un-GC'd
  "static" table; `tableFactory.createDynamicTable` was dead code for poker.
- **Fix:** that branch now calls `tableFactory.createDynamicTable({ ...smallBlind, bigBlind, session })`
  — `createDynamicTable` was extended with optional `smallBlind`/`bigBlind` params (default `0`,
  backward-compatible for the existing Trix/Tarneeb41 callers) and a poker-aware initial status
  (`"waiting"` vs. card games' `"open"`). Poker overflow tables are now correctly `tableKind:"dynamic"`
  with a `"Dynamic #N"` display name, so `pokerTableGcService` can actually garbage-collect them.
- **Auto-creation trigger confirmed reactive, by design:** matches the request's own example ("Table #1
  full → new player joins → auto-create Table #2"); no predictive pre-scaling exists or was added.
- **Tests:** `findAvailablePokerTable creates overflow tables via tableFactory as tableKind:dynamic`
  (asserts `tableKind`, display name, poker status, and non-zero blinds in one call).

### 7. Table auto-cleanup — **FIXED (boot-scaffold gap) + confirmed working GC**

- **Before:** `ensureFixedTierTables` (creates/backfills the 4 fixed static tables per tier) was never
  called at server boot — its only call site in the whole codebase was inside the legacy `GET
  /api/v1/tables` REST handler. The newer `/tables/lobby*` routes never triggered it. On a fresh
  deploy/fresh DB, the static-table scaffold might simply not exist.
- **Fix:** `ensureFixedTierTables()` is now called from `server.js`'s boot sequence (idempotent via its
  own existing singleton guard), before the boot sanitizer scans tables.
- **Confirmed already working:** `tableGcService`/`pokerTableGcService`'s idle sweeps (empty dynamic
  tables, idle card-game tables with zero connected sockets, Redis-recovered poker hands with no
  reconnecting sockets) and the boot-time zombie sanitizer (refunds + resets/deletes tables left mid-game
  after a crash) — all pre-existing and correct, now benefiting from the `tableKind` fix above (item 6)
  since previously-mismarked poker overflow tables can finally be swept.

### 8. Bot replacement — **PASS (with one hardening fix)**

- **Confirmed correct:** bots never get abruptly removed mid-hand in any game; Tarneeb41 lets any player
  claim any bot seat mid-game (by design); Trix restores only the original vacating player.
- **Fix (hardening):** poker's mid-hand seat allocation had a latent collision gap — the Mongo-side
  free-seat allocator and the live engine's bot-aware seat picker were independent, so
  `refreshSeatsFromDb`'s mid-hand branch could assign a joining human the same `seatPosition` an active
  bot already occupied in the live engine. Now checks for a live collision and reassigns to the next free
  chair before appending, reusing the same collision-avoidance logic the between-hands branch already had.
- **Fix (money correctness):** Tarneeb41's vacated-seat wallet lock wasn't forfeited at vacate time
  (unlike Trix, which forfeits immediately) — it was deferred to either a future claimant or final
  settlement, leaving a real window where a table torn down before normal settlement never resolved that
  lock. `tarneeb41BotSeatService.recordVacatedBotSeat` now forfeits immediately, mirroring Trix; safe
  against the later claim-time forfeit attempt since `forfeitTableSeatLock` clamps to the remaining locked
  amount and no-ops on a second call.

### 9. Player leave — **FIXED (Mongo/engine desync)**

- **Before:** REST `leaveTable` for Trix/Tarneeb41 only spliced the Mongo seat and cashed out — it never
  synced the live in-memory engine mid-hand (unlike poker's leave path, which does). A mid-hand REST leave
  could desync Mongo (seat empty, funds returned) from the engine (still dealing to a player it doesn't
  know left).
- **Fix:** `tableService.leaveTable` now detects an active hand via the live game instance and, if one is
  running, routes through `cardTableVacateService.finalizeCardTableVacate` (the same bot-takeover
  mechanism already used for disconnect/`leave_room`) instead of directly splicing the seat. Leaving
  before/between hands is unaffected (still the direct cash-out path).

### 10. Server restart — **PASS (already correct) + benefits from item 7's boot-scaffold fix**

`runBootSanitizer` (`services/tableGcService.js`, called from `server.js` before sockets accept
connections) recovers pending settlements, refunds/resets zombie card and poker tables (including queued
players, both Mongo and Redis queue modes), and defers Redis-snapshot-recoverable poker hands to a later
sweep. Confirmed correct and unchanged; now runs after the fixed-table scaffold is guaranteed to exist.

### 11. Heartbeat — **TUNED (user-selected approach)**

Per explicit choice (this is a backend-only pass; the Flutter client doesn't emit an app-level heartbeat
for game tables today, so a new client-server heartbeat protocol was out of scope), Socket.IO's built-in
transport ping/pong remains the heartbeat mechanism — it already is one. `pingInterval`/`pingTimeout` were
tightened from the framework defaults (~25s/20s) to an admin-configurable 10s/10s (`SOCKET_PING_INTERVAL_MS`
/ `SOCKET_PING_TIMEOUT_MS`), shrinking the worst-case "still shown connected" window on a hard network
failure before any reconnect/vacate timer even starts.

### 12. Ghost players — **FIXED (root cause) + added detection**

- **Root cause fixed:** item 2 above — the dead poker vacate pipeline was the actual source of permanent
  ghost seats; wiring it in resolves this at the source rather than papering over it with cleanup sweeps.
- **New:** duplicate-socket / multi-tab false-positive-disconnect guard. Previously, closing one of two
  open tabs unconditionally fired the disconnect handler and started a reconnect/vacate timer against a
  user still actively connected via the other tab (and for card games, could even wipe out the *live*
  socket's `roomManager` reference, since that map was a last-write-wins single slot). New
  `services/socketPresenceService.js` (Redis-backed counter when available, in-memory fallback otherwise —
  same pattern as `pokerCollusionGuard`'s presence tracking) counts live sockets per `(userId, tableId)`;
  disconnect handling for both poker (`sockets/tableGame.js`) and card games
  (`socket/handlers/game.handlers.js`) now only proceeds when the disconnecting socket was the user's
  *last* live socket for that table.
- **New:** admin dashboard ghost-seat signal (item 15) surfaces any `SITTING_OUT` seat whose reconnect
  window has already elapsed, as an ongoing regression signal — should read ~0 now.

### 13. Matchmaking — **PASS (already correct)**

Confirmed: players always receive an available table or one is created; no scenario found where a join
fails because "all tables are full." Reactive auto-creation (item 6) covers this by design.

### 14. Concurrency — **FIXED (2 real gaps) + confirmed protected (with a noted dependency)**

- **Fixed — unlocked in-transaction fallback:** `executePokerJoinTransaction`'s fallback (hit when the
  caller's originally-targeted table turns out full *inside* an open Mongo transaction) used to
  find-or-create a replacement table **without** going through `withPokerAllocationLock` — the one
  serialization primitive that exists specifically to prevent duplicate overflow-table creation under
  burst load, and which must never be acquired from inside an open transaction (would risk blocking other
  in-flight transactions). Removed that unlocked fallback entirely; it now just throws `TABLE_FULL` and
  lets the outer `joinPokerWithRetry` retry loop (which already correctly uses the lock, outside any
  transaction) pick the next table. Verified via two rewritten end-to-end tests exercising
  `joinPokerWithRetry` (previously they tested the removed in-transaction behavior directly).
- **Fixed — card-game waiting-queue race:** `waitingQueueService`'s enqueue/dequeue/cancel were
  unprotected read-modify-`table.save()` — two concurrent enqueues on the same table could lose one entry
  (last-write-wins on the array). Replaced with atomic `findOneAndUpdate` + `$push`/`$pop`/`$pull`.
- **Confirmed protected, with a noted dependency:** same-table double-join is protected by a real Mongo
  transaction (session re-validation + the schema-level capacity cap + the `E11000` retry loop on table
  creation) — **but only when MongoDB transactions are actually active in production.**
  `walletLedgerService`'s non-transaction fallback (intended for standalone-Mongo local dev) would silently
  disable this protection if ever enabled against a non-replica-set production database; there is no
  independent DB-level guardrail (e.g. a unique index on seat occupancy) as a last-resort backstop. Flagged
  here as an operational/config risk, not a code bug — `assertTransactionsAvailableOrThrow` already fails
  fast at boot when `APP_MODE=production` and transactions aren't available.

### 15. Admin tools — **ADDED (was minimal)**

- **Before:** `routes/adminRoute.js` exposed `GET /tables`, `GET /realtime-tables`, and `POST
  /force-end-hand` only — no reconnect-timer visibility, no bot/human breakdown, no ghost-player signal,
  no memory usage.
- **Fix:** new `GET /api/v1/admin/table-lifecycle-overview` (`services/adminService.js`, reusing the
  existing `buildAdminRealtimeTablePayload`/`getLiveTableGameForAdmin` live-snapshot helpers rather than
  rebuilding them) returns: table counts by `status` and `tableKind` (active/waiting/closing at a glance),
  bot-vs-human seat counts per table and in aggregate, active reconnect timers (poker, from live
  `seat.reconnectDeadline`) and vacate timers (poker + card games, from Mongo `vacatingPlayers`) with
  remaining time, a ghost-seat count (see item 12), and `process.memoryUsage()`. Plus
  `GET`/`PUT /api/v1/admin/table-lifecycle-settings` (item 3) for the reconnect/vacate timeout knobs.

---

## Files changed

**New:** `services/socketPresenceService.js`, `services/tableLifecycleSettingsService.js`,
`models/tableLifecycleSettingsModel.js`, `docs/TABLE_LIFECYCLE_AUDIT.md`

**Modified (production code):** `sockets/tableGame.js`, `services/pokerVacateService.js`,
`services/pokerTableAllocationService.js`, `services/tableFactory.js`, `services/tableLifecycleService.js`,
`services/tableAllocationService.js`, `services/tableService.js`, `services/cardTableVacateService.js`,
`services/tarneeb41BotSeatService.js`, `services/waitingQueueService.js`, `services/pokerWaitingQueueService.js`,
`services/adminService.js`, `socket/handlers/game.handlers.js`, `utils/redis/pokerQueueRedis.js`,
`utils/lobbyRealtime.js`, `routes/adminRoute.js`, `server.js`

**Modified (tests):** `test/table.audit-fixes.test.js` (2 tests rewritten to match the corrected
concurrency architecture, 5 new), `test/poker.gameplay-e2e.test.js` (3 new)

All changes are additive: no public method signatures were narrowed, no socket event names or payload
shapes changed, no existing call sites broken (verified by the full test suite staying at the documented
pre-existing failure baseline with zero new failures).
