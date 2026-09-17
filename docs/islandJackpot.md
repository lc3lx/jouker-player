# Island Jackpot — Production Readiness

## Round tickets

The table island button opens a dialog over the current poker table. A purchase
reserves one ticket for the next hand in which the seated player is dealt cards.
Purchases made after the hand-start cutoff cannot qualify for that hand.
`POST /join` requires `tableId`; duplicate pending purchases do not charge again.
Idempotency keys are scoped to the authenticated user and remain valid after the
ticket has been consumed.

`POST /auto-buy` accepts `{tableId, enabled}`. The server buys once per dealt hand
at this table, using a prepaid ticket first. It stops automatic buying on
insufficient wallet funds. Disabling auto-buy preserves an already paid ticket.
Tickets are not consumed while the island is disabled. Leaving the table causes
no further charges; an unused paid ticket remains reserved for that table.

`GET /status` now requires authentication and accepts `tableId` and optional
`handId`. Personal fields are `nextHandPurchased`, `currentHandPurchased` and
`autoBuy`. They are never cached as shared pool state.

Payout eligibility uses the immutable `(userId, handId, tableId)` ticket, not
legacy lifetime membership. The final non-folded hand must qualify at showdown.
Existing trigger and multiple-winner policies still apply. The initial rollout
migrates older pool percentages to royal flush **80%**, straight flush **30%**,
and four of a kind **10%**; later admin configuration remains supported.

Deploy backend and client together. Production schema startup installs the
ticket unique index and repairs the legacy transaction-key index. Duplicate
non-empty transaction keys stop startup for review; history is never deleted.
No production database or deployment is changed by the local test suite.

## Feature flag

```env
ISLAND_JACKPOT_ENABLED=true
```

Legacy table-seat jackpot (`POKER_LEGACY_JACKPOT_ENABLED`) is separate and must remain `false`.

## Architecture

- **Hook:** `phase3HandArchiveService.onHandSettled` → `islandJackpotService.onHandSettled` (async, non-blocking)
- **Wallet:** `island_jackpot_entry` / `island_jackpot_win` ledger types
- **Hand eval:** server-only via `utils/islandJackpotHand.js` → `bestOf7`
- **Cache:** 5s status cache + Redis optional; in-memory payout locks when Redis absent
- **Daily fill:** house adds **10,000,000 coins** once per UTC day (`ISLAND_DAILY_FILL_AMOUNT`). Idempotent via `lastDailyFillDayUtc`.

## Admin API

`PUT /api/v1/admin/island-jackpot/config`

| Field | Description |
|-------|-------------|
| `entryFee` | Join cost (wallet chips) |
| `minTriggerAmount` | Pool must reach this before payouts |
| `payoutPercentages.*` | Royal / SF / Quads share of pool |
| `payoutPolicy.maxWinnersPerEvent` | 1–2 |
| `settings.hotJackpotThreshold` | Visual hot state threshold |
| `settings.effectsEnabled` | Socket visual updates |
| `settings.announcementsEnabled` | Win broadcasts |

## Tests

```bash
npm run test:island-jackpot
```

Integration tests use **MongoDB Memory Server (replica set)** with real transactions.

## Load test

```bash
LOAD_PLAYERS=4000 LOAD_TABLES=500 node scripts/loadTestIslandJackpot.js
```

## Economy simulation

```bash
npm run simulate:island-economy
```

## Production checklist

- [ ] MongoDB replica set (transactions required)
- [ ] Redis for multi-instance payout locks + status cache
- [ ] `WalletTransaction` enum includes `island_jackpot_entry` / `island_jackpot_win`
- [ ] Monitor `island_jackpot_payout_failed` logs
