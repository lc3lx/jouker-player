"use strict";

/**
 * The same money flows, on a STANDALONE mongod — which is what production
 * actually runs.
 *
 * Every other suite here uses a replica set, so every one of them exercises a
 * real transaction and none of them touch the code path the live server takes.
 * `withMongoTransaction` hands back a null session on a standalone server and
 * the callback runs anyway, so a failure halfway through rolls back nothing:
 * the compensating actions are the only thing standing between a player and
 * being charged for a name they did not get.
 *
 * These tests inject failures at each step and assert the money and the
 * resource both end up where they started.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Player = require("../models/playerModel");
const SpecialPlayerId = require("../models/specialPlayerIdModel");
const RetiredPlayerId = require("../models/retiredPlayerIdModel");
const ledger = require("../services/walletLedgerService");
const playerIdService = require("../services/playerIdService");
const nameSvc = require("../services/playerNameService");
const idSvc = require("../services/specialPlayerIdService");
const { ensurePlayerIdIndexes } = require("../services/playerIdSchemaService");

let mongod = null;
const savedEnv = {};
let seq = 0;

async function makeUser(balance = 100_000_000) {
  seq += 1;
  const user = await User.create({
    name: `لاعب ${seq}`,
    email: `sa${seq}.${Date.now()}@test.local`,
    password: "x".repeat(12),
  });
  await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
  return user;
}

const balanceOf = async (u) =>
  (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
const nameOf = async (u) => (await User.findById(u).select("name").lean())?.name;
const countOf = async (u) =>
  (await User.findById(u).select("nameChangeCount").lean())?.nameChangeCount ?? 0;
const playerIdOf = async (u) =>
  (await User.findById(u).select("playerId").lean())?.playerId ?? null;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE", "APP_MODE"]) {
    savedEnv[k] = process.env[k];
  }
  // A standalone server, and the fallback left enabled — production's shape.
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  delete process.env.APP_MODE;
  ledger.resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(mongod.getUri(), { dbName: "standalone_test" });
  await ensurePlayerIdIndexes();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (mongod) await mongod.stop();
  ledger.resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("this suite really is running without transactions", async () => {
  // If this ever starts passing a session, every other test in the file is
  // silently testing the replica-set path instead and proves nothing.
  let sawSession = "not-run";
  await ledger.withMongoTransaction(async (session) => {
    sawSession = session;
  });
  assert.equal(sawSession, null, "standalone mongod must yield a null session");
});

/* ------------------------------------------------------------- rename -- */

test("renaming works on a standalone server", async () => {
  const user = await makeUser(100_000_000);

  const res = await nameSvc.changeName({ userId: user._id, name: "اسم صالح" });

  assert.equal(res.charged, 1_000_000);
  assert.equal(await nameOf(user._id), "اسم صالح");
  assert.equal(await balanceOf(user._id), 99_000_000);
  assert.equal(await countOf(user._id), 1);
});

test("a failed charge releases the rename slot", async () => {
  const user = await makeUser(500); // nowhere near a million
  const before = await nameOf(user._id);

  await assert.rejects(
    () => nameSvc.changeName({ userId: user._id, name: "اسم غالي" }),
    (err) => err.statusCode === 402
  );

  assert.equal(await balanceOf(user._id), 500, "not charged");
  assert.equal(await nameOf(user._id), before, "name unchanged");
  assert.equal(
    await countOf(user._id),
    0,
    "the slot was given back — without compensation this player would have " +
      "silently lost one of their three renames"
  );
});

test("a failure after the charge refunds it and releases the slot", async () => {
  const user = await makeUser(100_000_000);
  const before = await nameOf(user._id);

  // Break the step that writes the new name, after the money has moved.
  const realUpdate = User.updateOne.bind(User);
  let broken = true;
  User.updateOne = (filter, update, ...rest) => {
    if (broken && update?.$set?.name !== undefined) {
      broken = false;
      return Promise.reject(new Error("INJECTED_WRITE_FAILURE"));
    }
    return realUpdate(filter, update, ...rest);
  };

  try {
    await assert.rejects(
      () => nameSvc.changeName({ userId: user._id, name: "اسم جديد" }),
      /INJECTED_WRITE_FAILURE/
    );
  } finally {
    User.updateOne = realUpdate;
  }

  assert.equal(await nameOf(user._id), before, "name unchanged");
  assert.equal(
    await balanceOf(user._id),
    100_000_000,
    "the fee was refunded — this is the case that would otherwise take a " +
      "million chips for nothing"
  );
  assert.equal(await countOf(user._id), 0, "the slot was given back");

  const refund = await WalletTransaction.findOne({
    userId: user._id,
    type: "refund",
  }).lean();
  assert.ok(refund, "the refund is on the ledger, not just in the balance");
  assert.equal(refund.amount, 1_000_000);
});

test("the three-rename cap still holds without transactions", async () => {
  const user = await makeUser(100_000_000);
  await nameSvc.changeName({ userId: user._id, name: "الاسم الأول" });
  await nameSvc.changeName({ userId: user._id, name: "الاسم الثاني" });
  await nameSvc.changeName({ userId: user._id, name: "الاسم الثالث" });

  const before = await balanceOf(user._id);
  await assert.rejects(
    () => nameSvc.changeName({ userId: user._id, name: "الاسم الرابع" }),
    (err) => err.statusCode === 409
  );
  assert.equal(await balanceOf(user._id), before);
  assert.equal(await nameOf(user._id), "الاسم الثالث");
});

/* ----------------------------------------------------------- purchase -- */

async function listNumber(number, price) {
  await SpecialPlayerId.deleteOne({ number });
  await RetiredPlayerId.deleteOne({ number });
  return SpecialPlayerId.create({ number, price, status: "listed" });
}

test("buying a vanity number works on a standalone server", async () => {
  await listNumber(901, 40_000);
  const user = await makeUser(1_000_000);
  await playerIdService.ensurePlayerId(user._id);
  const old = await playerIdOf(user._id);

  const res = await idSvc.purchaseSpecialId({ userId: user._id, number: 901 });

  assert.equal(res.playerId, 901);
  assert.equal(await playerIdOf(user._id), 901);
  assert.equal(await balanceOf(user._id), 960_000);
  assert.ok(await RetiredPlayerId.findOne({ number: old }).lean());
});

test("a failed charge puts the number back on sale", async () => {
  await listNumber(902, 900_000);
  const user = await makeUser(1_000);
  await playerIdService.ensurePlayerId(user._id);
  const before = await playerIdOf(user._id);

  await assert.rejects(
    () => idSvc.purchaseSpecialId({ userId: user._id, number: 902 }),
    (err) => err.statusCode === 402
  );

  assert.equal(await balanceOf(user._id), 1_000, "not charged");
  assert.equal(await playerIdOf(user._id), before, "number unchanged");
  const listing = await SpecialPlayerId.findOne({ number: 902 }).lean();
  assert.equal(
    listing.status,
    "listed",
    "the number went back on the market — without compensation a failed " +
      "purchase would remove it from sale permanently",
  );
  assert.equal(listing.owner, null);
});

test("a failure after the charge refunds it and relists the number", async () => {
  await listNumber(903, 25_000);
  const user = await makeUser(1_000_000);
  await playerIdService.ensurePlayerId(user._id);
  const before = await playerIdOf(user._id);

  // Break the assignment, after the money has moved and the number is claimed.
  const real = playerIdService.assignPlayerId;
  playerIdService.assignPlayerId = () =>
    Promise.reject(new Error("INJECTED_ASSIGN_FAILURE"));

  try {
    await assert.rejects(
      () => idSvc.purchaseSpecialId({ userId: user._id, number: 903 }),
      /INJECTED_ASSIGN_FAILURE/
    );
  } finally {
    playerIdService.assignPlayerId = real;
  }

  assert.equal(await playerIdOf(user._id), before, "number unchanged");
  assert.equal(await balanceOf(user._id), 1_000_000, "the fee was refunded");
  const listing = await SpecialPlayerId.findOne({ number: 903 }).lean();
  assert.equal(listing.status, "listed", "and it is back on sale");
});

test("a double submit is still charged once", async () => {
  await listNumber(904, 15_000);
  const user = await makeUser(1_000_000);
  await playerIdService.ensurePlayerId(user._id);
  const key = "standalone-dup";

  await idSvc.purchaseSpecialId({ userId: user._id, number: 904, requestKey: key });
  const second = await idSvc.purchaseSpecialId({
    userId: user._id,
    number: 904,
    requestKey: key,
  });

  assert.equal(second.duplicate, true);
  assert.equal(await balanceOf(user._id), 985_000);
});

test("the rename syncs the denormalized display name here too", async () => {
  const user = await makeUser(100_000_000);
  await Player.create({ user: user._id, displayName: "قديم" });

  await nameSvc.changeName({ userId: user._id, name: "اسم محدّث" });

  const player = await Player.findOne({ user: user._id }).lean();
  assert.equal(player.displayName, "اسم محدّث");
});
