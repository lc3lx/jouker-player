# Persistent Realistic Bots — Production Audit

## What was built

The existing per-game bot AIs (Poker in `sockets/tableGame.js`, Trix `engine/bots/TrixBot.js`,
Tarneeb `engine/bots/TarneebBot.js`) were **evolved, not rebuilt**, into believable long-term
players with persistent identities, personalities, skill tiers, human-like timing, localized
chat/emoji, drifting profiles/stats, and full admin control — every piece reusing existing systems.

### Core principle — identity is decoupled from money
Settlement already sets `userId: isBot ? null : uid` for any `isBot:true` seat
(`gameSettlementService.participantsFromTableAndGame`). So bots were given **real persistent User
identities** (name, avatar, profile, cosmetics-key, stats) while their seats keep `isBot:true` —
meaning **bots never move real coins through the wallet ledger**. Bot "coins" are a cosmetic
displayed balance drifted by a post-game hook, fully decoupled from settlement.

### New files (additive)
| File | Purpose |
|------|---------|
| `config/botConfig.js` | 20-bot seed catalog, 8 personalities, 4 skills, tuning tables, localized chat lines, LOCAL avatar keys |
| `models/botSettingsModel.js` | Admin-tunable singleton config (`getDefaults()`) |
| `services/botPoolService.js` | In-memory persistent-identity pool (sync acquire/release) + `isBotUser` registry |
| `services/botBehaviorService.js` | Personality/skill tuning math + human-like `thinkDelay` |
| `services/botProfileService.js` | Post-game stats/coins/lastOnline drift + activity heartbeat (never touches the ledger) |
| `services/botChatService.js` | Localized, rate-limited chat/emoji builder reusing `tableChat.buildChatMessage` |
| `services/botAdminService.js` + `routes/adminBotRoute.js` | Admin REST: bot CRUD + global config + avatar catalog, all audited |
| `scripts/seedBots.js` (`npm run seed:bots`) | Idempotent 20-bot seeding |

### Additive edits to existing code (identity/tuning only)
- `models/userModel.js` — `isBot` + `bot` subdoc (same User model, no fake-player model).
- `sockets/tableGame.js` — `createBotSeat` overlays a pool identity; `playBotTurn` thresholds and the
  think delay are personality-scaled; a read-only post-hand hook drifts bot profiles and emits chat.
- `games/tarneeb41/Tarneeb41Game.js`, `games/trix/TrixGame.js` — `fillWithBots`/`convertHumanToBot`
  overlay pool identity; bot decisions pass optional tuning; game-end drifts profiles + emits `bot_chat`.
- `engine/bots/TrixBot.js`, `engine/bots/TarneebBot.js` — **optional** `opts` arg; with no opts the
  output is byte-identical to before (regression-proven).
- `socket/handlers/game.handlers.js` — forwards `bot_chat` to the table + spectator rooms.
- `server.js` — warms the pool, syncs admin config into live caches, starts the activity heartbeat.
- `routes/index.js` — mounts `/api/v1/admin/bots` before the generic `/admin` router.

---

## Result: PASS

| Check | Result |
|-------|--------|
| New bot tests | **22 / 22 pass** (`bots.economy-safety`, `bots.behavior`, `bots.identity`) |
| Full backend suite | 585 tests, **48 fail — all pre-existing Trix/Tarneeb** |
| New failures introduced | **0** (non-Trix/Tarneeb failure count = 0) |
| Card-engine failure set vs baseline | **identical** (45 == 45, same test names) |
| End-to-end wiring | routes mounted, services load, `bot_chat` forwarded, boot init present, settlement guard intact |

### Verified guarantees

**Economy safety (the critical invariant) — `bots.economy-safety.test.js`, 6 tests**
- Giving a bot seat a real User id + a funded wallet: the settlement plan still nulls the bot's
  `userId` and pays it `0`; the bot's wallet is **byte-identical before/after** (never debited or
  credited) across poker, trix and tarneeb.
- A bot "winning" a hand pays the human via the **house**, not the bot's wallet.
- Persistent-bot settlement outcome is **byte-identical** to the legacy synthetic-bot outcome
  (human net, house net, rake) — proof the identity change cannot leak into the real economy.

**Behavior — `bots.behavior.test.js`, 8 tests**
- Personality scales the existing poker thresholds (aggressive raises more, passive less); `null`
  tuning returns the base unchanged.
- `thinkDelay` is randomized, floored, and personality-scaled (aggressive thinks faster than passive)
  — never a constant.
- Skill governs mistakes: expert never misplays; easy deviates a meaningful fraction of the time.
- **Regression:** `TrixBot`/`TarneebBot` with no opts are byte-identical to their prior output.

**Identity + admin — `bots.identity.test.js`, 8 tests**
- Pool loads persistent bots; `acquire` returns a real identity with tuning; `isBotUser` recognizes
  persistent bots AND legacy `bot:`/`bot_fill_` ids.
- Unique per table; graceful cross-table reuse when the small pool is exhausted (scales to hundreds
  of tables); `release` frees a bot; disabled bots are excluded.
- Admin CRUD (create/list/update/enable/delete) + config update + audit entries for every action.

---

## Requirement coverage

- **Bot accounts** — real `User` docs (`isBot:true`), same model, with wallet/profile/stats/cosmetic-key/VIP-optional. ✔
- **Bot library (20)** — seeded catalog, admin-editable (names/avatars/bios/personalities/skills/cosmetics). ✔
- **Personalities (8) & skills (4)** — tuning tables injected into the existing decisions per game. ✔
- **Reaction timing** — randomized, personality-scaled, never instant. ✔
- **Chat & emoji** — localized (ar/en), personality-flavored, per-bot + per-table rate limited, reusing the human table-chat path (no new client logic). ✔
- **Profiles & activity** — drift via a post-game hook + activity heartbeat; render through the existing `playerProfileService`. ✔
- **Table fill / social** — existing delayed-fill + graceful vacate/drain preserved; bots join only with a human present. ✔
- **Admin panel** — REST APIs (enable/disable, max bots, min humans, skill, chat/emoji frequency, join/leave delays, activity, CRUD). ✔
- **Persistence, sockets, performance** — Mongo-backed; same socket events; in-memory pool + O(1) tuning + rate-limited chat scale to hundreds. ✔
- **No internet avatars** — LOCAL managed asset keys only (`assets/bots/bot_avatar_NN`), admin-editable. ✔
- **No duplicated systems** — reused Users, Profiles, Economy, VIP, Cosmetics, Chat, Achievements, Stats, Friends. ✔

## Notes / accepted design
- **Bot chat is wired for all three games** via the existing chat rooms; card games route it through a
  one-line `bot_chat` forwarder in the bridge (no engine coupling to sockets).
- **Bot displayed coins are a faucet-free cosmetic** — they drift within bounds and are floored, and
  are never a settlement counterparty, so they cannot affect the real economy or house reconciliation.
- **Standalone Mongo:** the pool/behavior/chat paths need no transactions; only admin writes do, and
  those degrade gracefully (production runs a replica set, already enforced at boot).

## Reproducing
```bash
cd backend
npm run seed:bots                       # seed the 20-bot library
node --test test/bots.economy-safety.test.js test/bots.behavior.test.js test/bots.identity.test.js
```
