"use strict";

/**
 * A full public table sends the player to another one.
 *
 * With watching removed, this is the *only* thing a player can do at a full
 * public table — so if it does not work they are simply stuck, with no way in
 * and nothing to look at. That is why it is tested here rather than assumed.
 *
 * It also pins the fact the invited-guest rule depends on: bots live in engine
 * memory and are not written to `table.seats`, so a table "full of bots" has
 * room in Mongo and a guest sits down immediately instead of waiting.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const { openSeatCount } = require("../services/tableAdmissionService");

let mongo = null;
const savedEnv = {};
let tableService = null;

/** Minimal express double: capture whatever the handler sends. */
function runHandler(handler, { params = {}, user = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ statusCode: this.statusCode, body });
      },
    };
    const next = (err) => (err ? reject(err) : resolve({ next: true }));
    Promise.resolve(handler({ params, user, query: {}, body: {} }, res, next)).catch(reject);
  });
}

let seq = 7100;
async function makeTable({
  seated = 0,
  capacity = 6,
  isPrivate = false,
  owner = null,
  tableKind = "dynamic",
  tier = "beginner",
  smallBlind = 10,
  bigBlind = 20,
  minBuyIn = 1000,
  maxBuyIn = 2000,
} = {}) {
  return Table.create({
    gameType: "poker",
    tier,
    tableNumber: seq++,
    smallBlind,
    bigBlind,
    minBuyIn,
    maxBuyIn,
    capacity,
    status: "waiting",
    tableKind,
    isPrivate,
    owner,
    seats: Array.from({ length: seated }, (_, i) => ({
      user: new mongoose.Types.ObjectId(),
      chips: minBuyIn,
      seatPosition: i,
    })),
  });
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI"]) savedEnv[k] = process.env[k];
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(mongo.getUri(), { dbName: "poker_overflow_test" });
  tableService = require("../services/tableService");
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (mongo) await mongo.stop();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test.beforeEach(async () => {
  await Table.deleteMany({});
});

// ── the way out of a full table ───────────────────────────────────────────

test("a full public table hands back a different table", async () => {
  const full = await makeTable({ seated: 6, capacity: 6 });
  const { body } = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(full._id) },
  });

  assert.ok(body?.data, "no table was offered");
  assert.notEqual(
    String(body.data._id),
    String(full._id),
    "the player was sent back to the table that had no room"
  );
  assert.ok(
    body.data.seatedCount < body.data.capacity,
    "the table offered is full too"
  );
});

test("the new table plays the same game for the same money", async () => {
  // Landing at a different stake would take money the player did not agree to.
  const full = await makeTable({
    seated: 5,
    capacity: 5,
    smallBlind: 500,
    bigBlind: 1000,
    minBuyIn: 50_000,
    maxBuyIn: 100_000,
  });
  const { body } = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(full._id) },
  });

  assert.equal(body.data.smallBlind, 500);
  assert.equal(body.data.bigBlind, 1000);
  assert.equal(body.data.minBuyIn, 50_000);
  assert.equal(body.data.maxBuyIn, 100_000);
  // A five-max spill must not land in the nine-max room at the same stake.
  assert.equal(body.data.capacity, 5, "the room changed size");
  assert.equal(body.data.tier, full.tier);
  assert.equal(body.data.isPrivate, false);
});

test("a table that still has room is handed straight back", async () => {
  // Opening a second table for someone who could have sat at the first would
  // scatter players across half-empty rooms.
  const roomy = await makeTable({ seated: 2, capacity: 6 });
  const { body } = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(roomy._id) },
  });
  assert.equal(String(body.data._id), String(roomy._id));
  assert.equal(await Table.countDocuments({}), 1, "a table was created for no reason");
});

test("it prefers an existing table with room over making a new one", async () => {
  const full = await makeTable({ seated: 6, capacity: 6 });
  const sibling = await makeTable({ seated: 1, capacity: 6 });

  const { body } = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(full._id) },
  });
  assert.equal(
    String(body.data._id),
    String(sibling._id),
    "a new table was created while a matching one sat nearly empty"
  );
});

// ── what it refuses ───────────────────────────────────────────────────────

test("a private or owned table has no overflow", async () => {
  // Someone's own room is not interchangeable with another one.
  const priv = await makeTable({
    seated: 6,
    capacity: 6,
    isPrivate: true,
    owner: new mongoose.Types.ObjectId(),
  });
  const res = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(priv._id) },
  }).catch((e) => ({ err: e }));
  assert.ok(res.err || res.next, "a private table was spilled into a public one");
});

test("a table that does not exist is refused, not guessed at", async () => {
  const res = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(new mongoose.Types.ObjectId()) },
  }).catch((e) => ({ err: e }));
  assert.ok(res.err || res.next);
});

// ── the fact the invited-guest rule rests on ──────────────────────────────

test("bots do not fill the table as far as Mongo is concerned", async () => {
  // Bots live in engine memory (`createBotSeat` pushes onto `this.seats`), so
  // a table thick with them still has seats here — which is why an invited
  // guest at a "bot-filled" table sits down at once instead of waiting, and
  // why the admission gate counts these seats and not the engine's.
  const withBotsOnly = await makeTable({ seated: 0, capacity: 6 });
  assert.equal(openSeatCount(withBotsOnly, 6), 6);

  const oneHuman = await makeTable({ seated: 1, capacity: 6 });
  assert.equal(openSeatCount(oneHuman, 6), 5);

  // And such a table is never treated as needing overflow.
  const { body } = await runHandler(tableService.preparePokerOverflow, {
    params: { id: String(withBotsOnly._id) },
  });
  assert.equal(String(body.data._id), String(withBotsOnly._id));
});

console.log("pokerOverflow.test.js: all tests registered");
