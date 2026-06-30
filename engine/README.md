# Game Engine — Foundation Phase

`backend/engine/` is the shared game-engine layer for Trix, Tarneeb41, and Poker. It was introduced in the Foundation Phase refactor to give the three games a common structural foundation without rewriting any existing game logic or breaking the Flutter client's wire protocol.

## What's here (Foundation Phase — complete)

| File | Purpose |
|------|---------|
| `BaseGameEngine.js` | Abstract base class — superset of `games/base/BaseGame.js`. TrixGame and Tarneeb41Game now extend this instead of BaseGame. Poker uses a duck-typing adapter (see §Poker Adapter). |
| `TimerManager.js` | Process-wide singleton: one global 200ms tick loop instead of 10,000+ native timers at 5000-table scale. `timerManager.schedule(roomId, category, delayMs, cb, {repeat})` / `.clear(id)` / `.clearAll(roomId)`. |
| `StateMachine.js` | Small reusable FSM helper. Used as a parallel mirror alongside each game's bare `this.state` string — audit/enforcement layer, not a replacement for the string field. |
| `ActionPipeline.js` | Stages 1-4 guard (auth → seat → reconnect → game-running). Wired into `socket/handlers/game.handlers.js` mutating handlers. Adds a `code` field alongside existing `reason` in `invalid_move` emissions. |
| `errors/ErrorCodes.js` | 9 unified error code constants + `codeForReason(str)` mapping from existing free-text reason strings. |
| `states/trixStates.js` | Trix transition table + `STATE` constants. |
| `states/tarneeb41States.js` | Tarneeb41 transition table + `STATE` constants. |
| `states/pokerStates.js` | Read-only mirror of PokerTable's `ROUND_TRANSITIONS` — documentation only, not enforced. |
| `bots/TrixBot.js` | Relocated from `games/trix/ai/BotAI.js` (old path re-exports this). |
| `bots/TarneebBot.js` | Extracted from Tarneeb41Game's inline `_botBid()`/`_pickAutoPlayCard()`. |

### BaseGameEngine hook mapping

| New hook | Generalizes |
|----------|------------|
| `joinPlayer` | `syncLobbyFromTable()` + `addPlayer()` at call site — no-op default |
| `leavePlayer` | `convertHumanToBot()` — no-op default |
| `reconnectPlayer` | `restoreHumanAtSeat()` (Tarneeb41), `PokerTable.onPlayerSocketConnected()` |
| `startGame`/`endGame` | Existing `startGame()`; `endGame()` is a forward-looking hook |
| `settlement` | Stays in `services/gameSettlementService.js` — no-op hook |
| `startTurnTimer`/`stopTurnTimer` | `_restartTurnTimer()`/`clearTurnTimer()` |
| `emitState` | `notifyStateChanged()` / `broadcastState()` — no-op default |
| `serialize`/`deserialize` | Poker's `serializeSnapshot()`/`restoreFromSnapshot()` via adapter |
| `destroy` | Existing `destroy()` + `timerManager.clearAll(roomId)` |

### Poker adapter

`PokerTable` does **not** extend `BaseGameEngine` — its constructor `(nsp, table, options)` is incompatible. Instead, ~30 lines of thin pass-through methods were added directly to the `PokerTable` class in `sockets/tableGame.js` (additive only, zero existing lines changed):

```js
serialize()          → serializeSnapshot()
deserialize(data)    → restoreFromSnapshot(data)
emitState()          → broadcastState()
reconnectPlayer(uid) → onPlayerSocketConnected(uid)
leavePlayer(uid)     → onPlayerSocketDisconnected(uid)
get state()          → this.round         // safe: no prior .state property
isGameFinished()     → always false       // tables don't permanently end; GC manages lifecycle
```

---

## Roadmap — 10 deferred items

Each item was scoped out of the Foundation Phase (multi-week effort touching real-money settlement, or requiring coordinated Flutter client changes).

### 1. Snapshot system unification

**Target files:** `engine/utils/cardGameStateStore.js` (new), `rooms/roomManager.js` (recovery watcher).

Extend `BaseGameEngine`'s `serialize()`/`deserialize()` with real implementations for Trix and Tarneeb41 (Poker already has `serializeSnapshot`/`restoreFromSnapshot` backed by `RedisTableStateStore`). Wire a recovery watcher in `roomManager.js` similar to Poker's existing `registerPokerRecoveryWatch`, so a restarted process can rebuild a Trix/Tarneeb41 game mid-hand from Redis.

### 2. Event sourcing

**Target files:** `engine/EventLog.js` (new), optional `models/gameEventModel.js`.

Implement a ring-buffer event log (same cap pattern as `processedMoveIds` — 500 entries, prune to 250) hooked at `ActionPipeline`'s stage 7→8 boundary. Durable replay goes into `gameEventModel.js` for audit and replay. Useful for debugging disputed hands in real-money games.

### 3. Full BotEngine

**Target files:** `engine/bots/BotEngine.js` (new).

Generalize the TrixBot/TarneebBot extraction into a `BotEngine` with `registerStrategy(gameType, fn)` and `tick(game)`, so each game's `checkBotTurn()` becomes a single call into it rather than duplicated polling loops. Note: the current 900ms (Trix) vs 1500ms (Tarneeb41) cadence difference is a gameplay-tuning decision that should be an explicit separate change, not silently bundled into an infra refactor.

### 4. Standardized socket events

**Target files:** new parallel handler module alongside existing namespaces.

Add `join_table` / `leave_table` / `player_action` / `state_update` generic events registered *alongside* the existing game-specific events — never replacing them. Translate generic payloads into each game's `applyMove` via `ActionPipeline`. Old event names (`select_game`, `tarneeb41_declare`, `play_card`, etc.) keep working indefinitely for the Flutter client.

### 5. Analytics

**Target files:** `socket/handlers/game.handlers.js`, `services/analyticsService.js`.

Wire `ActionPipeline` stage 8 (post-execution) to call `services/analyticsService.js`'s existing `trackEventServerFireAndForget` for Trix/Tarneeb41 card actions. Poker already does this internally; Trix/Tarneeb41 don't — this is the parity gap.

### 6. Match history

**Target files:** `models/gameHistoryModel.js` (new), `services/gameSettlementService.js`.

Generic `gameHistoryModel` (gameType-agnostic) populated from the EventLog at `endGame()`/settlement time, giving Trix/Tarneeb41 parity with Poker's existing `HandHistory`. Requires event sourcing (item 2) to be useful.

### 7. Table factory (static/dynamic/VIP)

**Target files:** `services/tableFactory.js` (new), `models/tableModel.js`.

Formalize the partially-existing functions (`ensureFixedTierTables`, `findAvailableFixedCapacityTable`, `findAvailablePokerTable`) into a unified `tableFactory.js`. Extend `tableModel.js`'s `tier` enum with `vip`. **Security note:** the current `password` field on table documents is plaintext — hash it before any real VIP launch.

### 8. Lobby separation

**Target files:** `services/lobbyService.js` (new), refactor of `services/tableService.js`.

Extract read/query concerns from `services/tableService.js` (864 lines mixing write, lifecycle, and query operations) into a new `lobbyService.js`. Improves testability and makes it possible to scale the lobby read path independently (e.g., caching, replica reads).

### 9. Crash recovery hardening

**Target files:** `services/gameGcService.js` (new, unifying the two existing sweep loops).

Unify `services/tableGcService.js` and `services/pokerTableGcService.js` — currently two separate duplicated sweep loops — under one `gameGcService.js` with pluggable per-gameType zombie predicates. Reduces the surface for one GC loop being updated without the other.

### 10. Performance work

**Target files:** `scripts/loadTestTableGame.js`, `socket/handlers/game.handlers.js`.

Extend the existing `scripts/loadTestTableGame.js` load-test script (currently poker-only) to drive Trix/Tarneeb41 concurrency too. Evaluate whether `game.handlers.js`'s manual per-socket broadcast loop (iterating `nsp.sockets` to find room members) becomes a bottleneck at 5000-table scale vs Socket.IO's built-in room-based `nsp.to("room:X").emit(...)`. The TimerManager's single tick loop already removes the native-timer bottleneck.

---

## Auth middleware consolidation (out-of-scope note)

Three Socket.IO namespaces (`/game`, `/table-game`, `/rtc`) each duplicate the JWT auth middleware. These should be extracted to a shared `socket/middleware/jwtAuth.js` in a future cleanup pass — no behavior change, pure DRY.
