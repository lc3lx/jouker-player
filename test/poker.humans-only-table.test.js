/**
 * A humans-only poker table must never seat a bot — by any route.
 *
 * `settings.botsEnabled: false` only gates the paths that ask. Two did not:
 *
 *  1. `resetStateFromTable` re-derived the policy from `table.settings`, and it
 *     is also called with synthetic stand-ins (a null tableDoc, an empty table
 *     after a reset) that carry no `settings`. `undefined !== false` reads as
 *     "bots allowed", so an empty five-max table quietly re-enabled them.
 *  2. The vacate-expiry path seated a bot on the leaver's chair unconditionally.
 *
 * These lock both doors, plus the ordinary fill paths.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const mongoose = require("mongoose");
const { PokerTable } = require("../sockets/tableGame");
const pokerVacateService = require("../services/pokerVacateService");

function createNspStub() {
  return {
    to: () => ({ emit() {} }),
    in: () => ({ async fetchSockets() { return []; } }),
  };
}

function mkHumansOnlyTable({ humans = 1, capacity = 5 } = {}) {
  const seats = Array.from({ length: humans }, (_, i) => ({
    user: { _id: `u${i}`, name: `P${i}` },
    chips: 10000,
    seatPosition: i,
  }));
  const g = new PokerTable(createNspStub(), {
    _id: "table-humans-only",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity,
    seats,
    settings: { botsEnabled: false },
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};
  g.autoRebuyBustedHumans = async () => 0;
  return g;
}

function botCount(game) {
  return game.seats.filter((s) => s && s.isBot).length;
}

test("a five-max table starts with bots disabled", () => {
  const g = mkHumansOnlyTable();
  assert.equal(g.botsEnabled, false);
  assert.equal(g.capacity, 5);
});

test("the ordinary fill path adds nothing", () => {
  const g = mkHumansOnlyTable();
  assert.equal(g.addBotsForMissingSeats(), 0);
  assert.equal(botCount(g), 0);
});

test("the fill timer is never armed", () => {
  const g = mkHumansOnlyTable();
  g.isOwner = true;
  g.running = true;
  g.scheduleBotFillIfNeeded();
  assert.equal(g.botFillTimer, null, "no bot fill may be scheduled");
});

test("a reset with no table document does not re-enable bots", () => {
  const g = mkHumansOnlyTable();

  // The synthetic stand-in used when the table doc is missing.
  g.resetStateFromTable({ seats: [], settings: { botsEnabled: g.botsEnabled } });
  assert.equal(g.botsEnabled, false, "policy survives a reset with no doc");

  // And a stand-in that forgot to carry settings at all must not flip it back.
  g.resetStateFromTable({ seats: [] });
  assert.equal(
    g.botsEnabled,
    false,
    "a document with no settings must leave the policy alone",
  );
  assert.equal(g.addBotsForMissingSeats(), 0);
});

test("a real document still drives the policy in both directions", () => {
  const g = mkHumansOnlyTable();

  g.resetStateFromTable({ seats: [], capacity: 9, settings: { botsEnabled: true } });
  assert.equal(g.botsEnabled, true, "an explicit true is honoured");

  g.resetStateFromTable({ seats: [], capacity: 5, settings: { botsEnabled: false } });
  assert.equal(g.botsEnabled, false, "an explicit false is honoured");
});

/** Drive onVacateExpired past its Mongo work and into the seat handover. */
async function runVacateExpiry(game, userId) {
  // A real id, or `isValidObjectId` bails before the handover is even reached.
  game.tableId = String(new mongoose.Types.ObjectId());
  const orig = pokerVacateService.finalizeVacateWithBot;
  pokerVacateService.finalizeVacateWithBot = async () => ({ ok: true });
  try {
    await game.onVacateExpired(userId);
  } finally {
    pokerVacateService.finalizeVacateWithBot = orig;
  }
}

test("an expired vacate opens the chair instead of seating a bot", async () => {
  const g = mkHumansOnlyTable({ humans: 2 });
  g.startIfReady = async () => {};
  g.pendingVacates.set("u1", { chips: 10000, seatIndex: 1 });

  await runVacateExpiry(g, "u1");

  assert.equal(botCount(g), 0, "no bot may inherit the seat");
});

test("an expired vacate on an ordinary table still hands the seat to a bot", async () => {
  const g = mkHumansOnlyTable({ humans: 2, capacity: 9 });
  g.botsEnabled = true;
  g.startIfReady = async () => {};
  g.pendingVacates.set("u1", { chips: 10000, seatIndex: 1 });

  await runVacateExpiry(g, "u1");

  assert.equal(botCount(g), 1, "the hand in flight must still be playable");
});

test("a nine-max table is unaffected — bots still allowed", () => {
  const g = new PokerTable(createNspStub(), {
    _id: "table-nine",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    seats: [{ user: { _id: "u0", name: "P0" }, chips: 10000, seatPosition: 0 }],
  });
  g.broadcastState = async () => {};
  g.syncMongoTableStatus = async () => {};

  assert.equal(g.botsEnabled, true);
  assert.ok(g.addBotsForMissingSeats() > 0, "the nine-max room still fills");
});
