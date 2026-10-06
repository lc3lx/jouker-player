process.env.NODE_ENV = "test";
process.env.POSEIDON_WALLET_MODE = "stub";
process.env.ZENOBIA_WALLET_MODE = "stub";

const test = require("node:test");
const assert = require("node:assert/strict");

const registry = require("../games/slotProfiles/registry");
const settings = require("../services/slotEconomySettingsService");
const economyRuntime = require("../games/utils/slotEconomyRuntime");
const economyStats = require("../games/utils/slotEconomyStats");
const operation = require("../games/utils/slotOperation");
const poseidonService = require("../games/poseidon/poseidonService");
const poseidonRounds = require("../games/poseidon/roundManager");
const poseidonWallet = require("../games/poseidon/poseidonWalletAdapter");
const adminService = require("../services/adminSlotEconomyService");

registry.verifyAll();
const ladder = registry.listProfiles("poseidon");
const ready = ladder.length >= 2;
const REASON = "test change";

function fresh() {
  settings._resetForTests();
  operation.clearForTests();
  poseidonRounds.clearAllForTests();
  poseidonWallet.clearStubForTests();
  economyStats._clearForTests();
}

async function goLive(game = "poseidon") {
  await settings.updateSettings(game, { economyLive: true }, { reason: REASON });
}

test("a game stays on its legacy economy until an admin switches it live", { skip: !ready }, async () => {
  fresh();
  assert.equal(settings.isEconomyLive("poseidon"), false);
  assert.equal(economyRuntime.resolveEconomy("poseidon", null, 3).economyVersion, 3);
  await goLive();
  const live = economyRuntime.resolveEconomy("poseidon", null, 3);
  assert.equal(live.economyVersion, 4);
  assert.equal(live.profile.id, registry.defaultProfileId("poseidon"));
  assert.equal(live.profile.targetRtp, 0.94);
});

test("every change needs a reason; bad profiles and stale revisions are refused", { skip: !ready }, async () => {
  fresh();
  await assert.rejects(settings.updateSettings("poseidon", { economyLive: true }, { reason: "" }), /reason/);
  await assert.rejects(settings.updateSettings("poseidon", { profileId: "nope" }, { reason: REASON }), /Unknown economy profile/);
  const other = registry.listProfiles("zeus")[0] || registry.listProfiles("zenobia")[0];
  if (other) {
    await assert.rejects(settings.updateSettings("poseidon", { profileId: other.id }, { reason: REASON }), /another game/);
  }
  await assert.rejects(settings.updateSettings("poseidon", { minBet: 5 }, { reason: REASON }), /minBet/);
  await assert.rejects(settings.updateSettings("poseidon", { houseEdge: 0.5 }, { reason: REASON }), /Unknown setting/);
  await settings.updateSettings("poseidon", { enabled: true }, { reason: REASON, expectedRevision: 0 });
  await assert.rejects(
    settings.updateSettings("poseidon", { enabled: false }, { reason: REASON, expectedRevision: 0 }),
    /changed by someone else/,
  );
});

test("a live profile switch is scheduled, then honours the 24h cooldown", { skip: !ready }, async () => {
  fresh();
  await goLive();
  const [low, high] = [ladder[0], ladder[ladder.length - 1]];
  const t0 = Date.now();
  await settings.updateSettings("poseidon", { profileId: low.id }, { reason: REASON, now: t0 });
  const s = settings.getSettings("poseidon");
  assert.equal(s.pending.profileId, low.id);
  assert.equal(settings.activeProfileId("poseidon", t0), registry.defaultProfileId("poseidon"), "not yet");
  assert.equal(settings.activeProfileId("poseidon", t0 + settings.SWITCH_DELAY_MS), low.id, "every instance flips together");
  await assert.rejects(
    settings.updateSettings("poseidon", { profileId: high.id }, { reason: REASON, now: t0 + 60_000 }),
    /once every 24 hours/,
  );
  await settings.updateSettings("poseidon", { profileId: high.id }, {
    reason: REASON, now: t0 + settings.PROFILE_CHANGE_COOLDOWN_MS + 1,
  });
  assert.equal(settings.getSettings("poseidon").activeProfileId, low.id, "the earlier switch was folded in");
});

test("buys quote the profile price and require the client to confirm it", { skip: !ready }, async () => {
  fresh();
  await goLive();
  poseidonWallet.seedStubBalance("live-buyer", 1e10);
  const profile = settings.activeProfile("poseidon");
  const bet = 10000;
  const cost = Math.round(bet * profile.buy.standardCost);

  await assert.rejects(poseidonService.executeBuyBonus("live-buyer", bet),
    (err) => err.statusCode === 426 && err.data.code === "client_update_required");
  await assert.rejects(poseidonService.executeBuyBonus("live-buyer", bet, { expectedCost: 25 * bet }),
    (err) => err.statusCode === 409 && err.data.code === "price_changed" && err.data.cost === cost);
  assert.equal(await poseidonWallet.getBalance("live-buyer"), 1e10, "nothing charged");

  const bought = await poseidonService.executeBuyBonus("live-buyer", bet, { expectedCost: cost });
  assert.equal(bought.cost, cost);
  assert.equal(bought.profileId, profile.id);
  const session = poseidonRounds.getBonusSession("live-buyer");
  assert.deepEqual(
    { v: session.economyVersion, p: session.profileId, o: session.origin, c: session.costPaid },
    { v: 4, p: profile.id, o: "buy", c: cost },
  );
  assert.equal(await poseidonWallet.getBalance("live-buyer"), 1e10 - cost);
});

test("a bought round keeps its profile after the admin switches; new spins follow the switch", { skip: !ready }, async () => {
  fresh();
  await goLive();
  poseidonWallet.seedStubBalance("pinned", 1e10);
  const original = settings.activeProfile("poseidon");
  const cost = Math.round(10000 * original.buy.standardCost);
  await poseidonService.executeBuyBonus("pinned", 10000, { expectedCost: cost });

  const other = ladder.find((p) => p.id !== original.id);
  await settings.updateSettings("poseidon", { profileId: other.id }, { reason: REASON, now: Date.now() - settings.SWITCH_DELAY_MS - 1 });
  assert.equal(settings.activeProfileId("poseidon"), other.id);

  let spins = 0;
  while (poseidonRounds.hasActiveBonusSession("pinned")) {
    const r = await poseidonService.executeSpin("pinned", 10000);
    assert.equal(r.isFreeSpin, true);
    assert.equal(r.profileId, original.id);
    assert.ok(++spins < 200);
  }
  const paid = await poseidonService.executeSpin("pinned", 10000);
  assert.equal(paid.isFreeSpin, false);
  assert.equal(paid.profileId, other.id);
  assert.equal(paid.economyVersion, 4);
});

test("closing a game stops paid play but lets a paid-for round finish", { skip: !ready }, async () => {
  fresh();
  await goLive();
  poseidonWallet.seedStubBalance("closing", 1e10);
  const profile = settings.activeProfile("poseidon");
  await poseidonService.executeBuyBonus("closing", 10000, { expectedCost: Math.round(10000 * profile.buy.standardCost) });
  await settings.updateSettings("poseidon", { enabled: false }, { reason: REASON });
  const free = await poseidonService.executeSpin("closing", 10000);
  assert.equal(free.isFreeSpin, true);
  while (poseidonRounds.hasActiveBonusSession("closing")) await poseidonService.executeSpin("closing", 10000);
  await assert.rejects(poseidonService.executeSpin("closing", 10000), (err) => err.statusCode === 503 && err.data.code === "game_disabled");
  await assert.rejects(poseidonService.executeBuyBonus("closing", 10000, { expectedCost: 1 }), (err) => err.data.code === "game_disabled");
});

test("admin bet limits narrow the allowed stake", { skip: !ready }, async () => {
  fresh();
  await settings.updateSettings("poseidon", { maxBet: 50000 }, { reason: REASON });
  poseidonWallet.seedStubBalance("limits", 1e10);
  await assert.rejects(poseidonService.executeSpin("limits", 60000), /between 10000 and 50000/);
  await poseidonService.executeSpin("limits", 50000);
});

test("spins and buys land in the hourly stats and the admin overview", { skip: !ready }, async () => {
  fresh();
  await goLive();
  poseidonWallet.seedStubBalance("stats", 1e10);
  for (let i = 0; i < 30; i += 1) await poseidonService.executeSpin("stats", 10000);
  const profile = settings.activeProfile("poseidon");
  await poseidonService.executeBuyBonus("stats", 10000, { expectedCost: Math.round(10000 * profile.buy.standardCost) });
  const rows = economyStats._memoryRows().filter((r) => r.profileId === profile.id);
  const paidSpins = rows.reduce((n, r) => n + (r.paidSpins || 0), 0);
  assert.ok(paidSpins >= 30, "paid spins (natural rounds may add free spins)");
  assert.equal(rows.reduce((n, r) => n + (r.buys || 0), 0), 1);

  const overview = await adminService._internal.gameOverview("poseidon");
  assert.equal(overview.activeProfile.id, profile.id);
  assert.ok(overview.windows["24h"].paidSpins >= 30);
  assert.ok(Array.isArray(overview.current.alerts));
  assert.ok(overview.windows["24h"].turnover > 0);
});

test("drift alerts fire on a broken hit rate but not on normal noise", { skip: !ready }, () => {
  const profile = settings.activeProfile("poseidon");
  const n = 50_000;
  const base = {
    paidSpins: n, paidBet: n, paidBetSq: n, paidWin: n * 0.9, plaqueSpins: n * profile.measured.plaqueVisibleRate,
    naturalTriggers: n * profile.params.naturalBonusProbability, jackpotTriggers: 5, naturalWin: 0, jackpotPaidBase: 0,
    buys: 0, buySpend: 0, buyWin: 0, jackpotPaidBuy: 0, superBuys: 0, superSpend: 0, superWin: 0, jackpotPaidSuper: 0,
  };
  const healthy = adminService._internal.alerts(profile, { ...base, paidHits: Math.round(n * profile.measured.hitRate) });
  assert.deepEqual(healthy.map((a) => a.code), []);
  const broken = adminService._internal.alerts(profile, { ...base, paidHits: Math.round(n * profile.measured.hitRate * 0.8) });
  assert.ok(broken.some((a) => a.code === "hit_rate_drift"));
});
