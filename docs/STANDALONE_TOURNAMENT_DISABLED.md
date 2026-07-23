# Standalone Legacy Tournament System — Disable Audit

## Decision: Option B — Disabled (not fixed)

Two research passes (frontend-usage check, line-by-line money-path re-verification) established this is
an incomplete, superseded feature rather than a live product with a fixable bug, so per the user's own
stated criterion ("Option B preferred if obsolete") every public entry point was disabled instead of
attempting a transactional rewrite of the registration/payout code.

### Why "obsolete," not "in use" — the evidence

1. **No creation path exists anywhere in the repository.** `POST /api/v1/tournaments` (admin/manager-gated)
   had zero callers before this change — no admin UI, no seed script, no cron job.
   `tournamentEngineService.startEngine()` only *resumes* tournaments already in Mongo on boot; it never
   creates one. In production, the `Tournament` collection was therefore always empty in practice —
   nothing for the one live lobby screen to ever display.
2. **The Flutter frontend (`frontapp/`) has almost no real integration.** Exactly one live call existed:
   `frontapp/lib/features/game/poker/kingtexas/mtt/poker_tournament_service.dart#fetchLobby()` →
   `GET /tournaments/lobby`, behind a button in the King Texas poker sub-menu. No registration call, no
   leaderboard call, no statistics call exists anywhere in the client. The one other client method that
   does exist, `fetchDetail()`, calls `GET /tournaments/lobby/:id` — a URL that has never matched any
   backend route (the backend only ever exposed `GET /lobby` and `GET /:id` separately) — that call has
   always 404'd and is unaffected by this change either way.
3. **The prize-payout path was structurally dead code for any real (2+ player) tournament.**
   `eliminatePlayer()` — the only function that ever sets `participants[].eliminated` — was never called
   anywhere in production code, so `advanceLifecycle`'s `alive.length <= 1` finish condition could never
   trip for 2+ participants. The one case that *could* reach `lifecycle:"finished"` (a lone single-player
   registrant) guaranteed fee loss with certainty, since `distributePrizes()` was still never wired to any
   wallet credit.
4. **No cancellation/refund path existed at all** (confirmed by full-repo grep for
   `cancelledAt|cancelReason|cancelTournament`) — a stuck tournament's entry fee was permanently
   unrecoverable by any code path that existed.
5. **No HTTP-layer test coverage** — the only pre-existing tests were 3 pure-function unit tests of
   internal math helpers (`test/final.release.test.js`), never exercising the actual route handlers.
6. **Git evidence points at supersession.** The parallel `ClanTournament` bracket system is untracked/newer
   in git, roughly 2x the code size (855 vs. 399 lines for the engine alone), and has dedicated
   concurrency/audit/economy test suites (`clan.audit.*.test.js`, `clan.tournament.test.js`) — consistent
   with being the actively-maintained replacement for this legacy system, not a sibling feature.

### The bug being closed

`services/tournamentService.js#registerTournament` (untouched, still on disk) debits the wallet via the
legacy non-transactional `wallet.addTransaction("debit", fee, ...)` call, then separately calls
`tournamentEngine.registerPlayer()` with no session/transaction linking the two and no compensating refund
if the second call fails (`"Registration closed"`, a raced `"Already registered"`, etc.) — a real,
reachable money-loss bug once the route was hit. After this change, that code path is **structurally
unreachable**: the route no longer calls it under any circumstances.

---

## What was changed

| # | File | Change |
|---|---|---|
| 1 | `routes/tournamentRoute.js` | Rewritten to a self-contained disable gate — no longer requires `tournamentService.js`, `tournamentEngineService.js`, or any validator. Every route now hits a trivial stub handler instead of the real one (table below). |
| 2 | `server.js` | Removed the `startTournamentEngine()` boot call (the 15s-per-tournament lifecycle tick loop is no longer started). `startClanTournamentEngine()` is untouched. |
| 3 | `services/monitoring/tournamentHealthChecks.js` | Header comment updated to note the system is now route-disabled; `checkStandaloneTournaments` keeps running unchanged as defense-in-depth for any pre-existing stuck documents. |
| 4 | `test/tournamentRoute.disabled.test.js` (new) | 12 regression tests proving every route's new behavior, that auth middleware is still intact on the money-mutating routes, and — the decisive check — that the route file's `require()` calls no longer reference `tournamentService`, `tournamentEngineService`, or `walletModel` at all. |

**Logic explicitly NOT changed** (kept intact, isolated, available for a future proper fix per "do not
delete"): `models/tournamentModel.js`, `services/tournamentService.js`,
`services/tournamentEngineService.js`, `utils/validators/tournamentValidator.js` — a follow-up
decommission-audit pass (below) added an `@deprecated` JSDoc header to each of these 4 files, but did not
change a single line of their actual logic. All still load cleanly and are unit-testable in isolation
(`test/final.release.test.js` still passes against `tournamentEngineService.js`'s pure helper functions,
unaffected by this change).

### Route-by-route before / after

| Route | Auth | Before | After |
|---|---|---|---|
| `GET /api/v1/tournaments` | public | Real Mongo query, paginated list | `200`, `{results:0, data:[], paginationResult:{...}}` — same shape, deliberately empty |
| `GET /api/v1/tournaments/lobby` | public | Real Mongo query via `getTournamentLobby()` | `200`, `{results:0, data:[]}` — **byte-identical in structure to today's already-empty response; the one live frontend caller is unaffected** |
| `GET /api/v1/tournaments/:id` | public | Real lookup, 404 if missing | `404`, "Tournament feature is currently unavailable" |
| `GET /api/v1/tournaments/:id/statistics` | public | Real stats query | `404`, same message |
| `GET /api/v1/tournaments/:id/leaderboard` | public | Real leaderboard query | `404`, same message |
| `POST /api/v1/tournaments` | admin/manager | Created a real tournament document | `410 Gone` — auth middleware (`protect` + `allowedTo("admin","manager")`) still runs first, unchanged |
| `POST /api/v1/tournaments/:id/register` | authenticated user | **The bug**: wallet debit + non-atomic registration | `410 Gone` — `protect` still runs first (unauthenticated requests still get `401`, unchanged); the debit code is never reached |

Socket.IO surface: confirmed (both in the original monitoring-audit research and re-confirmed here) this
system has zero dedicated socket events — pure REST, so there was nothing to reject there.

---

## Final verification: PASS

| Check | Result |
|---|---|
| No reachable path to the buggy registration code | **PASS** — `routes/tournamentRoute.js` no longer contains a `require()` of `tournamentService`, `tournamentEngineService`, or `walletModel` (verified both by reading the file and by an automated test asserting this against the actual `require()` call list, not just comment text) |
| Repo-wide grep for other callers of `registerTournament`/`createTournament` | **PASS** — the only non-test, non-clan-tournament matches are `routes/tournamentRoute.js`'s own header comment (prose, not a require) and `services/tournamentService.js` itself (the now-unreferenced original implementation) |
| Scheduled job stopped | **PASS** — `server.js` no longer calls `startTournamentEngine()`; `startClanTournamentEngine()` unaffected |
| Socket events rejected | **N/A / PASS** — none exist for this system, confirmed by grep, nothing to reject |
| Database compatibility preserved | **PASS** — no schema/model changes, no migrations, no document deletions |
| Code kept, not deleted | **PASS** — `tournamentModel.js`, `tournamentService.js`, `tournamentEngineService.js`, `tournamentValidator.js` all still present and load cleanly |
| Live frontend unaffected | **PASS** — `GET /lobby`'s response shape is unchanged from its current (already-empty) behavior; verified against the exact parsing code in `poker_tournament_service.dart#fetchLobby()` |
| No regressions | **PASS** — full backend suite: 613 tests, 565 pass, 48 fail (identical pre-existing Trix/Tarneeb baseline documented in `TABLE_LIFECYCLE_AUDIT.md`/`SYSTEM_MONITORING_AUDIT.md`), 0 new failures; 12/12 new tests pass |

**Verdict: PASS. Option B (disable) fully implemented.** The standalone Tournament system's public surface
is fully inert — no request through it can reach a wallet, and no scheduled job advances it — while every
line of its implementation remains on disk, unmodified, ready for a proper transactional rewrite (reusing
`withMongoTransaction`/`ledgerWithdraw`/`ledgerDeposit` the way `clanTournamentEngineService.js` already
does) if this feature is ever revived.

---

## Final decommission audit (follow-up pass)

A second, exhaustive repo-wide sweep across 10 specific isolation vectors, run after the initial disable
above. This pass found and closed **one real, previously-missed reachable path** (`sockets/rtc.js`, item 2
below) and added `@deprecated` markers to every legacy file (item 10). Every other vector was already
clean from the initial disable.

| # | Vector | Result | Evidence |
|---|---|---|---|
| 1 | No REST endpoint can reach the legacy engine | **PASS** | `routes/tournamentRoute.js` no longer `require()`s `tournamentService`/`tournamentEngineService`/`walletModel` (verified by the require-call-specific assertion in `test/tournamentRoute.disabled.test.js`, not just a text grep). Repo-wide grep for `tournamentService\|tournamentEngineService` across all `.js` files returns only: the route file itself, `server.js` (boot — see #3), the legacy files' own definitions, `sicboService.js` (a benign doc-comment analogy, "Mirrors services/tournamentEngineService.js (setInterval lifecycle tick)" — prose, not a require), and test files. |
| 2 | No Socket.IO namespace references the legacy system | **FIXED, now PASS** | `sockets/rtc.js` (the generic `/rtc` WebRTC-signaling namespace) previously `require()`d `models/tournamentModel.js` directly and, on a `join-room` event with `{type:"tournament"}`, queried `Tournament.findById(roomId)` to authorize joining a voice/video room — a real, independently-reachable path into the legacy model, unrelated to the REST disable. Fixed: the model import was removed and the branch now unconditionally denies with `join-denied: "tournament-feature-disabled"`, with no DB query at all. Confirmed via grep that no other file under `sockets/`/`socket/` requires `models/tournamentModel.js`. (`clan.js` was also grepped for "tournament" — its only matches are the unrelated clan-tournament realtime events, out of scope here.) |
| 3 | No scheduled job/cron/interval/background worker references it | **PASS** | `server.js` no longer calls `startTournamentEngine()` (removed in the initial disable pass, re-confirmed here by grep and by `test/tournamentRoute.disabled.test.js`'s dedicated assertion). `tournamentEngineService.js#scheduleTick`/`startEngine` still exist in the file but are never invoked by anything reachable — confirmed by grep for `scheduleTick\|startEngine` finding no external callers besides the file's own internals and `server.js`'s (removed) former call site. |
| 4 | No service imports or dynamically loads the legacy engine | **PASS** | Repo-wide grep for `require\(` calls referencing `tournamentService`/`tournamentEngineService`/`models/tournamentModel` (excluding the legacy files' own definitions, `sockets/rtc.js` now fixed, `services/monitoring/tournamentHealthChecks.js`'s intentional read-only monitor, and tests/docs) returns zero results. No dynamic/computed `require()` (template-string or variable-based module paths) exists anywhere in the backend that could indirectly resolve to these modules — confirmed by inspecting every `require(` call site the grep surfaced; all are static string literals. |
| 5 | No admin panel exposes it | **PASS** | Grep for `tournament` (case-insensitive) across every `routes/admin*.js` file returns zero matches — there never was a standalone-tournament admin route, and nothing was added. The only admin-adjacent surface for tournaments at all is the clan-tournament nested routes under `routes/clanRoute.js`, out of scope. |
| 6 | No menu, button, or navigation can reopen it | **PASS, with one caveat noted for transparency** | This decommission was scoped to the backend (`d:\work\play\backend`) — the Flutter client (`frontapp/`) was not modified. The one existing UI button (King Texas poker sub-menu → MTT lobby screen, `poker_lobby_screen.dart` → `kingtexas_mtt_lobby_screen.dart`) still exists and still navigates. Functionally, though, it can no longer "reopen" anything: it only calls the now-permanently-empty `GET /lobby` (item covered in the initial disable), no registration/create call exists anywhere client-side, and even if one were added, the server rejects it with `410`. So the entry point is UI-reachable but functionally inert — flagged here rather than silently claimed as fully removed, since removing the button itself is a frontend change outside this pass's backend scope. |
| 7 | No wallet, escrow, or settlement path can invoke it | **PASS** | `services/gameSettlementService.js`'s only tournament-related branch is the working clan-tournament hook (`if (table.clanTournamentMatch) { ... }`) — no standalone-system branch exists or ever did. `services/walletLedgerService.js` has zero tournament references of any kind (neither system has dedicated ledger functions; both compose the generic wallet primitives). The standalone system's own money path (`tournamentService.js#registerTournament`) is unreachable per item 1. |
| 8 | No webhook or event bus publishes events to it | **PASS** | `backend/domain/` (the domain-event-bus directory) has zero references to `Tournament`/tournament anywhere. `utils/alert.js#sendAlert` (the webhook dispatcher) is never called from any of the 4 legacy files. The only "event"-shaped output the legacy system ever had was its own `auditService.logEvent("tournament_register", ...)` call inside `registerTournament` — now unreachable per item 1. |
| 9 | No database migration or seed depends on it | **PASS** | No `migrations/` directory exists in the backend at all (only one unrelated script, `scripts/migrateCosmeticsVipV2.js`, matched a directory-name-style grep and is unrelated to tournaments). `scripts/seedClanSettings.js` and `scripts/seedAchievements.js` reference the string "tournament" only as clan-tournament *achievement metric names* (e.g. `tournamentWins`) — neither seeds nor queries the standalone `Tournament` model. No seed script creates `Tournament` documents (confirmed in the original disable audit and re-confirmed here). |
| 10 | Every legacy module marked `@deprecated` | **PASS** | Added a file-header `@deprecated` JSDoc block to all 4 remaining legacy files, each explicitly naming the `ClanTournament`/`clanTournamentEngineService.js` replacement and linking back to this doc: `models/tournamentModel.js`, `services/tournamentService.js`, `services/tournamentEngineService.js`, `utils/validators/tournamentValidator.js`. (`routes/tournamentRoute.js` already carried an equivalent explanatory header from the initial disable pass, describing the same thing in route-layer terms.) |

**Two additional things checked and confirmed benign** (not a coupling, no action needed):
- `routes/socialRoute.js` passes a `tournamentId` field through to `services/invitationService.js#sendInvitation`. Traced fully: this is a generic, opaque metadata field stored on a `GameInvitation` document and echoed back in a `invitation:received` socket payload for the *client* to interpret — `invitationService.js` never queries `models/tournamentModel.js` or validates the id against it, in either `sendInvitation` or `respondInvitation`. Not a reachable path into the legacy engine.
- `scripts/reconcileWallets.js`'s `clan_tournament_entry/prize/refund` ledger-type cases (added in the earlier table-lifecycle work) are for the **clan** tournament system's ledger types, unrelated to the standalone system, which has no dedicated ledger types of its own (it uses the generic legacy `wallet.addTransaction("debit", ...)` call, which is why it can never be reconciled by this script — a known, still-open gap that no longer matters in practice since registration is unreachable).

### Files touched in this follow-up pass
`sockets/rtc.js` (removed the `Tournament` model import and the reachable `join-room` branch — the one
real fix), `models/tournamentModel.js`, `services/tournamentService.js`,
`services/tournamentEngineService.js`, `utils/validators/tournamentValidator.js` (each got an
`@deprecated` header only — zero logic changes). Full backend suite re-run after these changes: 613
tests, 565 pass, the same 48 pre-existing unrelated failures, 0 new failures.

### Final verdict: **PASS**

The legacy standalone Tournament system is completely isolated. No REST endpoint, Socket.IO event,
scheduled job, service import, admin surface, wallet/settlement path, or event-bus/webhook can reach it.
Its files remain on disk, functionally inert, clearly marked `@deprecated`, and fully compatible with the
existing database for a future migration if the feature is ever properly rebuilt on the
`ClanTournament`-style transactional pattern.
