# Slot economy profiles: Poseidon, Zeus, Zenobia

Each of these three games has one global RTP, and that RTP is disclosed to players. The admin chooses it from a ladder of calibrated, immutable profiles (90 / 92 / **94 default** / 96 %). Nothing is adjusted per player, per bet size or per streak. The house edge comes only from the published profile.

## Moving parts

| Piece | Where |
|---|---|
| Profiles (immutable JSON) | `games/slotProfiles/<game>/<game>-rtpNN.json` |
| Registry: validation and outcome-digest check | `games/slotProfiles/registry.js` |
| Profile engines | Poseidon `spinEngine.v4.js`, Zeus `DiceEngine.v5.js`, Zenobia `spinEngine.v3.js` |
| Shared settlement (server **and** simulator) | `games/{poseidon,zenobia}/settlement.js`, `games/dice/kingArthSettlement.js` |
| Live settings (active profile, on/off, limits) | `models/slotEconomySettingsModel.js`, `services/slotEconomySettingsService.js` |
| Per-request decisions | `games/utils/slotEconomyRuntime.js` |
| Hourly stats | `models/slotEconomyStatModel.js`, `games/utils/slotEconomyStats.js` |
| Admin API | `/api/v1/admin/slot-economy` (`routes/adminSlotEconomyRoute.js`) |
| Admin page | `admin-web/src/pages/SlotEconomy.jsx` |
| Client prices | `frontapp/lib/features/game/slots/slot_economy.dart` |

## Rules worth knowing

- **Pinning.** A bonus round always plays the engine version and profile it was opened with, whatever the admin switches to later. Profiles are never deleted, only `retired`.
- **Profile switches.** A switch is written with `effectiveAt = now + 30s`. Every instance polls every 5 s, so all of them change odds at the same moment.
  - A profile can change at most once every 24 h once a game is live.
  - Every change needs a reason and is recorded in the audit chain (`slot_economy.settings.update`).
- **Buy price.**
  - The buy price equals the measured round EV divided by the target RTP, so buying a bonus returns the same RTP as normal play.
  - Clients must send `expectedCost`. The server answers 409 `price_changed` on a mismatch, and 426 `client_update_required` when the field is missing.
- **Zeus paid spins** must send `profileId`, so the server can never pick the odds after seeing the seed. `verify-spin` replays v5 spins using that profile.
- **Max win.** Live profiles cap a whole bonus round at 5000× (Zeus already did). Legacy sessions keep the per-spin cap they were sold with.
- **Transaction retries.** The outcome is seeded once per request outside the Mongo transaction (`games/utils/operationRng.js`). A transaction retry therefore replays the same outcome instead of re-rolling it.
- **Jackpots.** A jackpot round is never deleted unpaid. Past its reveal deadline (30 min), `services/slotJackpotSweeper.js` reveals the remaining cards in index order and settles the round. Clients reopen pending rounds through `GET …/jackpot/pending`.

## Operations

```bash
npm run test:slots                        # all slot tests
npm run slot:verify -- --game=zeus        # independent 20M-spin verification
npm run slot:calibrate -- --game=poseidon --write   # re-fit a ladder (after an engine change)
npm run slot:digests                      # legacy engine fingerprints (only for an intended change)
node tool/slotStatsReconcile.js --days=7  # stats vs wallet ledger
```

## Going live, per game

1. Deploy the backend. Every game stays on its legacy economy (`economyLive: false`).
2. Release the app version that reads prices from `/economy` and sends `expectedCost` / `profileId`.
3. In the admin page, choose the profile (94 % by default), then **Activate new system** and give a reason.
4. Watch the alerts. Rate checks (hit rate, plaque rate, bonus rate, jackpot rate) catch a misconfiguration within hours. Realized RTP needs a large volume before it means anything.
5. Once the overview shows zero legacy sessions, the legacy engines can be deleted.

Changing an engine changes the outcome digests. When that happens:

- Re-run calibration for every profile on that engine.
- The registry refuses to activate a profile whose digest no longer matches.
