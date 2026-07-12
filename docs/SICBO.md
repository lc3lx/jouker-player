# Sic Bo — Architecture, Socket Contract & Data Models

Sic Bo is a **continuous, one-global-shared-round, server-authoritative** dice game
integrated natively into the existing casino platform. It reuses the wallet/ledger,
provably-fair primitives, Socket.IO infrastructure, analytics, and the **slot betting
economy** (minimum bet 10,000). No separate system was created.

## Backend module map (`backend/games/sicbo/` + services/sockets/routes/models)

| File | Responsibility |
|---|---|
| `games/sicbo/sicboConstants.js` | Bet catalog + corrected-standard odds; chip ladder `[10k,20k,50k,100k,500k,1M]`; limits; phase timings (`SICBO_BET_MS`, `SICBO_RESULT_MS`). |
| `games/sicbo/sicboEngine.js` | **Pure** engine: `rollDice`, `evaluateBet`, `settleBets`, `summarize`. No I/O. |
| `games/sicbo/sicboSeed.js` | Per-round provably-fair commitment (`createRoundCommitment`, `verifyRound`). |
| `games/sicbo/sicboWalletAdapter.js` | Atomic **debit+persist at placement** (`placeBet`), idempotent `settleUserBets`, `refundUserBets`; per-user mutex. |
| `games/sicbo/sicboRoundManager.js` | Authoritative state machine: `openRound → lockRound → rollAndResult → settleRound`; `recoverStuckRounds`; snapshots. |
| `games/sicbo/sicboRoundState.js` | Redis **leader-lock** (heartbeat + TTL renewal + failover) + round cache. In-memory fallback for single-node/dev. |
| `games/sicbo/sicboRtp.js` | `CasinoGameStats` aggregation (`gameKey:"sicbo"`) + `simulate()` for RTP tests. |
| `services/sicboService.js` | The 24/7 engine loop (leader-only) + all socket emits. |
| `sockets/sicbo.js` | `/sicbo` namespace: JWT auth, rooms, `place_bet` validation, rate-limit + dedup. |
| `services/sicboPublicService.js` + `routes/sicboRoute.js` | REST: `/state`, `/history`, `/my-bets`, `/verify/:roundId`. |
| `services/adminSicboService.js` + `routes/adminSicboRoute.js` | Admin monitoring: `/monitor`, `/rounds`. |

**Edits to existing files (additive):** `models/miniGamePlayModel.js` enum += `"sicbo"`;
`routes/index.js` mounts `/api/v1/sicbo` + `/api/v1/admin/sicbo`; `server.js` calls
`initSicbo(io,{redis})`.

## Round lifecycle (mandatory order)

```
BETTING (25s) ──> LOCKED ──> ROLLING ──> RESULT ──> SETTLE WALLET ──> VERIFY COMPLETION ──> SETTLED ──> (new round)
```

- The three dice are **fixed at round open** (derived from the secret `serverSeed`, whose
  `sha256` hash is published immediately) and only **revealed at RESULT** — provably fair.
- Exactly one node runs the loop (Redis leader-lock, 15s TTL renewed every tick). On Redis
  error the node refuses to advance (no split-brain double settlement).
- **VERIFY COMPLETION:** `settleRound` records `settledCount/expectedSettlements`. If any user
  settlement fails, the round stays in `RESULT` and the watchdog/boot `recoverStuckRounds`
  re-runs it (idempotent — only `placed` bets are touched).

## Money safety

- **Every bet is debited AND persisted (`SicBoBet`) in one Mongo transaction at placement.**
  Nothing financial lives only in memory/Redis. Balance check + `ledgerWithdraw(game_loss)`.
- **Settlement** credits `ledgerDeposit(game_win)` only for `placed` bets, flipping them to
  `won/lost` transactionally → replays/recovery never double-pay. Guards: per-user mutex +
  unique `(roundId,userId,betType)` index + status flip + single-leader loop.
- House profit is tracked per round (`totalBetAmount - totalPayout`) and folded into
  `CasinoGameStats` for RTP (mirrors the slots; the house-wallet ledger is table-games only).

## Socket contract — namespace `/sicbo`, room `"sicbo"`

Auth: JWT in the handshake (`auth.token`). Each socket joins `"sicbo"` + `"sicbo:user:<id>"`.

**Server → Client**
| Event | Payload | When |
|---|---|---|
| `sicbo:round_state` | `{round, myBets, balance}` | on connect / `sicbo:join` (reconnect resync) |
| `sicbo:new_round` | `{roundId, status, bettingEnd, serverSeedHash, ...}` | new round opens |
| `sicbo:bet_open` | `{roundId, bettingEnd}` | betting opens |
| `sicbo:timer` | `{roundId, msLeft}` | throttled ~1/s during betting |
| `sicbo:bet_closed` | `{roundId}` | betting locks |
| `sicbo:dice_animation` | `{roundId, dice, serverSeed, clientSeed, nonce}` | result (seed revealed) |
| `sicbo:result` | `{roundId, dice, total, result, winningBetTypes}` | result computed |
| `sicbo:payout` | `{roundId, payout, wonBets, balance}` | **personal** (per-user room) |
| `sicbo:round_settled` | `{roundId, totals}` | round settled |

**Client → Server**
| Event | Payload | Notes |
|---|---|---|
| `sicbo:join` | — | request a fresh snapshot |
| `sicbo:place_bet` | `{betType, amount, actionId}` | acked `{ok, balance, totalOnZone, ...}`; validated against the live BETTING window inside the debit txn; rate-limited + actionId-deduped |
| `sicbo:leave` | — | leave rooms |

Reconnect / multi-device: `sicbo:join` always replies `sicbo:round_state` with the user's
persisted bets (`SicBoBet`) + wallet balance. All of a user's sockets share the personal room.

## Data models

**`SicBoRound`** — `roundId`(unique), `status`, `bettingStart/End`, `serverSeed`,
`serverSeedHash`, `clientSeed`, `nonce`, `dice1/2/3`, `total`, `resultBigSmall/OddEven`,
`isTriple`, `totalPlayers`, `totalBets`, `totalBetAmount`, `totalPayout`, `houseProfit`,
`expectedSettlements`, `settledCount`, `settlementError`.

**`SicBoBet`** — `userId`, `roundId`, `betType`, `amount`(original), `odds`,
`status`(placed/won/lost/refunded), `payout`, `settlementKey`, `settledAt`.
Unique index `(roundId,userId,betType)` (accumulate + double-settle guard); indexes
`(roundId,status)`, `(userId,createdAt)`.

## Provably-fair verification

`GET /api/v1/sicbo/verify/:roundId` returns `serverSeed`, `serverSeedHash`, `clientSeed`,
`nonce`, `dice`, `expectedDice`, and `valid`. A client reproduces the dice via
`HMAC_SHA256(serverSeed, clientSeed + "|" + nonce + "|" + counter)` (see `games/dice/seededRng.js`)
and confirms `sha256(serverSeed) === serverSeedHash`.

## Corrected standard Sic Bo odds (net)

Big/Small/Odd/Even 1:1 (**lose on any triple**); single die 1:1 / 2:1 / 3:1 by match count;
specific double 10:1; specific triple 180:1; any triple 30:1; two-dice combo 5:1; totals:
4/17→60, 5/16→30, 6/15→18, 7/14→12, 8/13→8, 9/12→6, 10/11→6.

## Tests

- `test/sicbo.engine.test.js` — 20 tests: dice determinism, provably-fair verify + tamper
  detection, uniform distribution, every bet family incl. Big/Small lose-on-triple and
  single-die 1/2/3, `settleBets`, and RTP simulation bands.
- `test/sicbo.integration.test.js` — 9 tests (in-memory Mongo replica set): bet debit +
  persistence, validation, accumulation, betting-window guard, settlement payout,
  **double-settlement prevention**, house-profit balance, refund, and stuck-round recovery.
- `scripts/smokeSicbo.js` — boots the live engine loop against Mongo and verifies a full
  round cycle (open → lock → roll → settle) with real event emission.
