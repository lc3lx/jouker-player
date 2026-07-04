# Island Jackpot — Production Readiness

## Feature flag

```env
ISLAND_JACKPOT_ENABLED=true
```

Legacy table-seat jackpot (`JACKPOT_ENABLED`) is separate and must remain `false`.

## Architecture

- **Hook:** `phase3HandArchiveService.onHandSettled` → `islandJackpotService.onHandSettled` (async, non-blocking)
- **Wallet:** `island_jackpot_entry` / `island_jackpot_win` ledger types
- **Hand eval:** server-only via `utils/islandJackpotHand.js` → `bestOf7`
- **Cache:** 5s status cache + Redis optional; in-memory payout locks when Redis absent

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
