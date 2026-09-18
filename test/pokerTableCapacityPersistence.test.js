/**
 * A poker table must keep its capacity across an empty-table reset.
 *
 * The reported bug: a five-max table vanished from the lobby after the player
 * who sat down stood up again. The row was never deleted — its `capacity` was
 * rewritten from 5 to 9, so the client grouped it with the nine-max room at the
 * same stake and the five-max lobby entry disappeared.
 *
 * Cause: `tableSchema.pre("save")` re-derived `capacity` (and `buyIn`,
 * `minimumBet`) from defaults. `resetPokerTableWhenEmpty` loads the document
 * with a partial `.select()` that omits those fields and then saves it, so the
 * hook read `undefined` and wrote the default over stored data. It was
 * invisible while every poker table happened to be nine-handed.
 *
 * Integration test against a throwaway local MongoDB; skipped when none is
 * reachable, matching test/friends.test.js.
 */
process.env.NODE_ENV = "test";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/poker_capacity_test_${process.pid}`;

let mongoAvailable = false;
let Table;

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    mongoAvailable = true;
  } catch (_) {
    return;
  }
  Table = require("../models/tableModel");
});

after(async () => {
  if (!mongoAvailable) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

function guarded(name, fn) {
  test(name, async (t) => {
    if (!mongoAvailable) {
      t.skip("no local MongoDB");
      return;
    }
    await fn(t);
  });
}

let seq = 0;
async function makeFiveMaxTable() {
  seq += 1;
  return Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: 900 + seq,
    tableKind: "static",
    smallBlind: 100,
    bigBlind: 200,
    buyIn: 10000,
    minimumBet: 1000,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 5,
    status: "waiting",
    settings: { botsEnabled: false },
  });
}

guarded("saving a partially loaded table does not re-default its capacity", async () => {
  const created = await makeFiveMaxTable();

  // Exactly what resetPokerTableWhenEmpty used to do: load a few fields, save.
  const partial = await Table.findById(created._id).select("gameType seats status");
  partial.status = "waiting";
  partial.seats = [];
  await partial.save();

  const after = await Table.findById(created._id).lean();
  assert.equal(after.capacity, 5, "capacity must survive a partial-select save");
  assert.equal(after.buyIn, 10000, "buyIn must survive too");
  assert.equal(after.minimumBet, 1000, "and minimumBet");
  assert.equal(after.settings.botsEnabled, false, "and the bot policy");
});

guarded("the empty-table reset leaves a five-max table five-handed", async () => {
  const created = await makeFiveMaxTable();
  const tid = String(created._id);

  created.seats.push({
    user: new mongoose.Types.ObjectId(),
    player: new mongoose.Types.ObjectId(),
    chips: 10000,
    seatPosition: 0,
  });
  await created.save();

  // Stand up, then run the reset the leave path calls.
  const seatedDoc = await Table.findById(tid);
  seatedDoc.seats = [];
  await seatedDoc.save();

  const gc = require("../services/pokerTableGcService");
  const result = await gc.resetPokerTableWhenEmpty(tid);
  assert.equal(result.reset, true);
  assert.equal(result.destroyed, false, "a static table is reset, never destroyed");

  const after = await Table.findById(tid).lean();
  assert.ok(after, "the table row must still exist");
  assert.equal(after.capacity, 5, "the five-max room must not become nine-max");
  assert.equal(after.status, "waiting", "and it must be listable in the lobby again");
  assert.equal(after.settings.botsEnabled, false, "still humans only");
});

guarded("a nine-max table is unaffected by the same reset", async () => {
  const nine = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: 950,
    tableKind: "static",
    smallBlind: 100,
    bigBlind: 200,
    buyIn: 10000,
    minimumBet: 1000,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
  });

  const gc = require("../services/pokerTableGcService");
  await gc.resetPokerTableWhenEmpty(String(nine._id));

  const after = await Table.findById(nine._id).lean();
  assert.equal(after.capacity, 9);
  assert.equal(after.status, "waiting");
});

guarded("a table still rejects more seats than it has", async () => {
  const created = await makeFiveMaxTable();
  const doc = await Table.findById(created._id);
  for (let i = 0; i < 6; i += 1) {
    doc.seats.push({
      user: new mongoose.Types.ObjectId(),
      player: new mongoose.Types.ObjectId(),
      chips: 10000,
      seatPosition: i,
    });
  }
  await assert.rejects(() => doc.save(), /TABLE_CAPACITY_EXCEEDED/);
});

guarded("the tournament bot-lock tick leaves humans-only tables alone", async () => {
  // lockTournamentBotsOnOpenTables carries a legacy repair that re-enables bots
  // on any non-tournament table found with botsEnabled:false. It runs on every
  // arena/clan scheduler tick, and it was switching the five-max rooms back on
  // seconds after boot had seeded them off — bots reappeared no matter what the
  // engine did.
  const fiveMax = await makeFiveMaxTable();
  const nineMax = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: 960,
    tableKind: "static",
    smallBlind: 100,
    bigBlind: 200,
    buyIn: 10000,
    minimumBet: 1000,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    // A full-size cash room that really was collateral damage.
    settings: { botsEnabled: false },
  });

  const tableFactory = require("../services/tableFactory");
  await tableFactory.lockTournamentBotsOnOpenTables();

  const five = await Table.findById(fiveMax._id).lean();
  assert.equal(
    five.settings.botsEnabled,
    false,
    "a five-max table is deliberately humans-only — never repaired back on",
  );

  const nine = await Table.findById(nineMax._id).lean();
  assert.equal(
    nine.settings.botsEnabled,
    true,
    "the legacy repair still fixes full-size cash tables",
  );
});
