# Clan System — Production Audit Report

**Scope:** concurrency, idempotency, money conservation and crash-recovery of the Clan
(Guild) system: clans, membership, invitations, join-requests, treasury, donations,
tournaments (escrow → payout), achievements, leaderboards, chat, notifications, admin
overrides and the `/clan` socket namespace.

**Method:** adversarial tests that drive the real services against a real MongoDB replica
set (genuine multi-document transactions), firing operations concurrently with
`Promise.allSettled` and asserting money/state invariants afterwards. No mocks on the
money path.

**Result: PASS** — after 6 defects were found and fixed.

| Suite | Tests | Result |
|---|---|---|
| `clan.audit.concurrency.test.js` | 14 | PASS |
| `clan.audit.integrity.test.js` | 14 | PASS |
| `clan.audit.stress.test.js` | 5 | PASS |
| Pre-existing clan functional suites | 41 | PASS |
| **Total** | **74** | **74 pass / 0 fail** |

---

## Defects found and fixed

All six were the same root cause: **check-then-act (TOCTOU)** — state was read, a decision
made, and the mutation applied later, letting concurrent callers all pass the same check.
Every fix replaces the read with an **atomic conditional claim** (`findOneAndUpdate` that
matches only in the pre-condition state), so exactly one caller wins.

### 1. CRITICAL — Tournament prize paid multiple times
`clanTournamentEngineService.resolveMatch`

`if (match.advanced) return` read an in-memory document; `match.advanced = true` was
written much later. Duplicate result reports (retried settlement callbacks, a double tap,
the walkover ticker racing a real result) all passed the guard and advanced the bracket
repeatedly — settling the final more than once.

*Measured impact:* 5 concurrent reports of one final paid **+2,000,000 against a 400,000
prize pool — a 5× duplication of coins created from nothing.*

**Fix:** atomically claim the match (`{_id, advanced:false}` → `advanced:true`) before any
bracket or money work. Losers receive `already_resolved`.

### 2. CRITICAL — Prize pool payable twice via direct settlement
`clanTournamentEngineService.finishTournament`

The terminal-lifecycle guard was checked long before `lifecycle` was written inside the
payout transaction, so concurrent settlements both paid out.

**Fix:** atomically claim the payout by transitioning out of a non-terminal lifecycle,
using the **pre-image** (`new: false`) as the authoritative escrow/participant snapshot.
On payout failure the claim is released so the tournament can be settled again rather than
being stranded as "finished" with nothing paid.

### 3. CRITICAL — Entry fees refunded more than once
`clanTournamentEngineService.cancelTournament`

Same pattern: lifecycle checked, refunds issued later. Concurrent cancels each refunded
the full participant list.

**Fix:** atomic cancellation claim returning the pre-image escrow snapshot; refunds run
once. Authorization is still evaluated *before* the claim so an unauthorized caller can
never transition the tournament. Refund failure restores the prior state.

### 4. HIGH — Clan could end up with multiple owners
`clanMembershipService.transferOwnership`

`clan.owner === actorId` was verified, then roles were rewritten. An owner issuing several
transfers concurrently promoted **every** target.

*Measured impact:* 5 concurrent transfers produced **5 members holding the `owner` role**.*

**Fix:** the ownership write is now an atomic claim (`{_id, owner: actorId}` →
`owner: target`) performed inside the transaction; losing callers are rejected with 403.

### 5. MEDIUM — Per-user daily donation cap bypassable
`clanTreasuryService.donate`

The cap was enforced by aggregating past donations and comparing — concurrent donations
all observed the same stale total.

*Measured impact:* **200,000 donated against a 50,000 daily cap** (20/20 concurrent
donations accepted). Coins remained conserved; the violation is of the business rule.

**Fix:** a rolling per-day counter on the member document
(`contribution.dailyDonated` / `dailyDonatedAt`) claimed with a single conditional
pipeline update that self-resets a stale day bucket and only matches while the resulting
total stays within the cap. A failed donation releases the claimed allowance.

### 6. MEDIUM — Escrow could drift from the seated roster
`clanTournamentEngineService.startTournament`

The tournament was loaded, then `save()`d. A concurrent `unregister` that pulled a
participant and decremented escrow was **undone** by the stale in-memory participants
array — resurrecting a refunded player into the bracket while the escrow decrement stuck.

*Measured impact:* 6 seated participants backed by only **500,000 of escrow instead of
600,000** — a player in the bracket who had already been refunded.*

**Fix:** atomically claim the start (`registering` → `seeding`). `unregister` only matches
while `registering`, so once the claim is held the roster cannot drift; the claimed
post-image is then written with a targeted update instead of a stale full save.

---

## Verified invariants (all passing)

**Money**
- Total coins are conserved across a full tournament: fees collected == prizes paid.
- Global conservation under chaos: `wallets + treasuries + live escrow` is unchanged
  across 300 concurrent players doing mixed operations.
- A prize pool is paid at most once, even under 5–6 concurrent settlement attempts.
- An entry fee is refunded at most once, and never after being paid out as a prize.
- A rejected payout (reconciliation failure) moves **zero** coins and rolls back.
- Payouts can never exceed the escrow collected (`paid <= escrowHeld`, asserted in-txn).
- Only seated players are charged; duplicate concurrent registration charges once.
- Treasury never goes negative; concurrent over-drafting is refused.
- Treasury balance always reconciles with its own append-only ledger.
- Achievement rewards are granted exactly once under concurrent evaluation.

**State**
- One clan per player holds under concurrent joins *and* concurrent invitation accepts.
- `memberCount` always equals the true `ClanMember` count after mass join/leave churn.
- Member capacity is never exceeded (60 concurrent joins into 5 seats → exactly 5).
- Tournament seats never exceed `maxPlayers` (50 concurrent registrations → exactly 8).
- Exactly one clan owner survives concurrent transfers; non-owners can never win a race.
- Only one pending join-request per (clan, user) despite request spam.

**Recovery & ordering**
- A settled tournament replays as a no-op (`finishTournament` + engine `tick` repeated).
- The walkover ticker cannot double-resolve a match that was reported concurrently.
- Notifications de-duplicate on `(sourceType, sourceId)` and are monotonically ordered.
- Clan chat history returns in true send order under rapid sends.
- Leaderboards exclude banned and deleted clans across every scope; ranks are contiguous
  and correctly ordered; reported member counts match reality.
- `/clan` socket joins personal + clan + clan-chat rooms on connect, restores the identical
  room set on reconnect, is safe for clanless users, and refuses `chat:join` for a clan the
  user does not belong to.
- Every admin override (ban, restore, config, treasury adjust, transfer) writes an audit
  entry attributed to the acting admin.

---

## Notes / accepted behaviour

- **Achievement rewards mint coins into the treasury.** This is an intentional faucet
  (like any bonus), not a conservation defect; conservation tests account for it.
- **Clan creation cost is a sink** — coins are destroyed, by design.
- **Standalone MongoDB fallback:** `withMongoTransaction` degrades to non-transactional
  execution on a standalone server. Every atomic claim added here is a *single-document*
  conditional update, so the idempotency guarantees still hold without transactions; only
  multi-document rollback weakens. Production must run a replica set (already enforced by
  `assertTransactionsAvailableOrThrow` at boot).

## Regression evidence

The six fixes touch shared services, so the rest of the backend was re-verified by running
the 60 non-clan test files on the current tree and again on a clean baseline (`git stash`
of all clan changes):

| Tree | Tests | Pass | Fail |
|---|---|---|---|
| With clan system + audit fixes | 486 | 438 | 48 |
| Clean baseline (clan work stashed) | 486 | 438 | 48 |

**Identical** — the clan system introduces no regressions. All 48 failures are pre-existing
Trix/Tarneeb game-engine tests (`Cannot read properties of null (reading 'currentKingIndex')`),
unrelated to clans and failing equally without any clan code present.

## Reproducing

```bash
cd backend
node --test test/clan.audit.concurrency.test.js \
             test/clan.audit.integrity.test.js \
             test/clan.audit.stress.test.js
```
