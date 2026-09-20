"use strict";

/**
 * Player numbers: allocation, retirement, the vanity store, and the admin
 * placement path — on a real Mongo replica set, because the properties worth
 * testing here are all about what happens when two writes race.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Counter = require("../models/counterModel");
const SpecialPlayerId = require("../models/specialPlayerIdModel");
const RetiredPlayerId = require("../models/retiredPlayerIdModel");
const {
  resetMongoTransactionProbeForTests,
} = require("../services/walletLedgerService");

const playerIdService = require("../services/playerIdService");
const specialPlayerIdService = require("../services/specialPlayerIdService");
const { ensurePlayerIdIndexes } = require("../services/playerIdSchemaService");
const { backfillPlayerIds } = require("../scripts/backfillPlayerIds");

let replSet = null;
const savedEnv = {};
let seq = 0;

async function makeUser({ balance = 0, playerId, createdAt } = {}) {
  seq += 1;
  const doc = {
    name: `لاعب ${seq}`,
    email: `p${seq}.${Date.now()}@test.local`,
    password: "x".repeat(12),
  };
  if (playerId !== undefined) doc.playerId = playerId;
  const user = await User.create(doc);
  if (createdAt) {
    // Straight through the driver: `timestamps: true` marks createdAt
    // immutable, so a mongoose `updateOne` silently drops the $set and the
    // fabricated join order would never take effect.
    await User.collection.updateOne({ _id: user._id }, { $set: { createdAt } });
  }
  await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
  return user;
}

const balanceOf = async (u) =>
  (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
const playerIdOf = async (u) =>
  (await User.findById(u).select("playerId").lean())?.playerId ?? null;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) {
    savedEnv[k] = process.env[k];
  }
  // Without this the ledger's transaction probe short-circuits to "unsupported"
  // and every transaction below silently degrades to a non-transactional run —
  // the race tests would then pass for entirely the wrong reason.
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "player_id_test" });
  await ensurePlayerIdIndexes();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/* ------------------------------------------------------------ allocator -- */

test("allocation is sequential and starts above the reserved ranges", async () => {
  const a = await playerIdService.allocateNextOrdinaryId();
  const b = await playerIdService.allocateNextOrdinaryId();
  const c = await playerIdService.allocateNextOrdinaryId();

  assert.ok(a >= playerIdService.ORDINARY_ID_MIN, `${a} >= 1001`);
  assert.equal(b, a + 1);
  assert.equal(c, b + 1);
});

test("fifty concurrent allocations hand out fifty distinct numbers", async () => {
  const drawn = await Promise.all(
    Array.from({ length: 50 }, () => playerIdService.allocateNextOrdinaryId())
  );
  assert.equal(new Set(drawn).size, 50, "no number was handed out twice");
});

test("the counter does not rewind when the highest holder is deleted", async () => {
  // This is the test that fails under a max+1 allocator, and the reason this
  // feature uses a counter: DELETE /api/v1/users/:id really removes the row.
  const first = await playerIdService.allocateNextOrdinaryId();
  const user = await makeUser({ playerId: first });

  await User.deleteOne({ _id: user._id });

  const second = await playerIdService.allocateNextOrdinaryId();
  assert.ok(second > first, `${second} > ${first} after the holder was deleted`);
});

test("ensurePlayerId is idempotent under concurrency", async () => {
  const user = await makeUser();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => playerIdService.ensurePlayerId(user._id))
  );
  const settled = await playerIdOf(user._id);

  assert.equal(typeof settled, "number");
  assert.equal(new Set(results).size, 1, "all callers saw one number");
  assert.equal(results[0], settled);
});

test("two users cannot hold the same number", async () => {
  const number = await playerIdService.allocateNextOrdinaryId();
  await makeUser({ playerId: number });
  const other = await makeUser();

  await assert.rejects(
    () => User.updateOne({ _id: other._id }, { $set: { playerId: number } }),
    (err) => err.code === 11000,
    "the unique index is installed and enforcing"
  );
});

test("un-numbered users do not collide with each other", async () => {
  // The partial index ignores absent values. A sparse index would too, but a
  // `default: null` plus sparse would not — this proves neither is in play.
  const a = await makeUser();
  const b = await makeUser();
  assert.equal(await playerIdOf(a._id), null);
  assert.equal(await playerIdOf(b._id), null);
});

/* ------------------------------------------------------------- purchase -- */

async function listNumber(number, price) {
  await SpecialPlayerId.deleteOne({ number });
  await RetiredPlayerId.deleteOne({ number });
  return SpecialPlayerId.create({ number, price, status: "listed" });
}

test("buying a vanity number moves the player and retires the old one", async () => {
  await listNumber(777, 50_000);
  const user = await makeUser({ balance: 100_000 });
  await playerIdService.ensurePlayerId(user._id);
  const before = await playerIdOf(user._id);

  const result = await specialPlayerIdService.purchaseSpecialId({
    userId: user._id,
    number: 777,
  });

  assert.equal(result.playerId, 777);
  assert.equal(result.previousPlayerId, before);
  assert.equal(await playerIdOf(user._id), 777);
  assert.equal(await balanceOf(user._id), 50_000);

  const tx = await WalletTransaction.findOne({
    userId: user._id,
    type: "special_id_purchase",
  }).lean();
  assert.ok(tx, "a ledger row was written");
  assert.equal(tx.amount, 50_000);

  const listing = await SpecialPlayerId.findOne({ number: 777 }).lean();
  assert.equal(listing.status, "sold");
  assert.equal(String(listing.owner), String(user._id));

  const retired = await RetiredPlayerId.findOne({ number: before }).lean();
  assert.ok(retired, "the old number was burnt");
  assert.equal(retired.reason, "special_purchase");
});

test("a retired number is never handed out again", async () => {
  await listNumber(778, 10_000);
  const user = await makeUser({ balance: 50_000 });
  await playerIdService.ensurePlayerId(user._id);
  const old = await playerIdOf(user._id);

  await specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 778 });

  assert.equal(await playerIdService.isRetired(old), true);

  // Not even an admin can resurrect it. The guard sits in assignPlayerId
  // itself, so no caller can reach past it.
  const other = await makeUser();
  await assert.rejects(
    () =>
      playerIdService.assignPlayerId({
        session: null,
        userId: other._id,
        number: old,
        reason: "admin_change",
      }),
    /متقاعد/
  );
  assert.notEqual(await playerIdOf(other._id), old);
});

test("insufficient balance changes nothing at all", async () => {
  await listNumber(779, 900_000);
  const user = await makeUser({ balance: 1_000 });
  await playerIdService.ensurePlayerId(user._id);
  const before = await playerIdOf(user._id);

  await assert.rejects(
    () => specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 779 }),
    (err) => err.statusCode === 402
  );

  assert.equal(await balanceOf(user._id), 1_000, "no partial debit");
  assert.equal(await playerIdOf(user._id), before, "number unchanged");
  const listing = await SpecialPlayerId.findOne({ number: 779 }).lean();
  assert.equal(listing.status, "listed", "the claim rolled back");
  assert.equal(
    await WalletTransaction.countDocuments({
      userId: user._id,
      type: "special_id_purchase",
    }),
    0
  );
});

test("two buyers race for one number: one wins, the loser is not charged", async () => {
  // The assertion that matters is the loser's balance. It fails the moment
  // anyone reorders the service to debit before claiming the listing.
  await listNumber(780, 20_000);
  const a = await makeUser({ balance: 100_000 });
  const b = await makeUser({ balance: 100_000 });
  await Promise.all([
    playerIdService.ensurePlayerId(a._id),
    playerIdService.ensurePlayerId(b._id),
  ]);

  const results = await Promise.allSettled([
    specialPlayerIdService.purchaseSpecialId({ userId: a._id, number: 780 }),
    specialPlayerIdService.purchaseSpecialId({ userId: b._id, number: 780 }),
  ]);

  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one purchase succeeded");
  assert.equal(lost.length, 1);

  const winner = (await playerIdOf(a._id)) === 780 ? a : b;
  const loser = winner === a ? b : a;

  assert.equal(await balanceOf(winner._id), 80_000, "winner paid once");
  assert.equal(await balanceOf(loser._id), 100_000, "loser paid nothing");
  assert.notEqual(await playerIdOf(loser._id), 780);
});

test("a purchase refuses to run without a real transaction", async () => {
  // This is the guarantee the rest of the money safety rests on. Without a
  // session, withMongoTransaction runs the callback anyway and a failure
  // halfway through would leave a player debited and un-numbered.
  const ledger = require("../services/walletLedgerService");
  const real = ledger.withMongoTransaction;
  ledger.withMongoTransaction = (work) => work(null);

  await listNumber(785, 1_000);
  const user = await makeUser({ balance: 50_000 });
  try {
    await assert.rejects(
      () => specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 785 }),
      // 503, not a bare Error: a database that is not a replica set is an
      // operator problem, and reaching the player as an opaque 500 tells
      // nobody anything.
      (err) => err.statusCode === 503
    );
  } finally {
    ledger.withMongoTransaction = real;
  }

  assert.equal(await balanceOf(user._id), 50_000, "nothing was charged");
  const listing = await SpecialPlayerId.findOne({ number: 785 }).lean();
  assert.equal(listing.status, "listed", "nothing was claimed");
});

test("the same buyer submitting twice is charged once", async () => {
  await listNumber(781, 15_000);
  const user = await makeUser({ balance: 100_000 });
  await playerIdService.ensurePlayerId(user._id);
  const key = "req-781";

  await specialPlayerIdService.purchaseSpecialId({
    userId: user._id,
    number: 781,
    requestKey: key,
  });
  const second = await specialPlayerIdService.purchaseSpecialId({
    userId: user._id,
    number: 781,
    requestKey: key,
  });

  assert.equal(second.duplicate, true);
  assert.equal(await balanceOf(user._id), 85_000, "debited exactly once");
  assert.equal(
    await WalletTransaction.countDocuments({
      userId: user._id,
      type: "special_id_purchase",
    }),
    1
  );
});

test("upgrading off a vanity number destroys it", async () => {
  await listNumber(782, 5_000);
  await listNumber(783, 5_000);
  const user = await makeUser({ balance: 100_000 });
  await playerIdService.ensurePlayerId(user._id);

  await specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 782 });
  await specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 783 });

  assert.equal(await playerIdOf(user._id), 783);
  const old = await SpecialPlayerId.findOne({ number: 782 }).lean();
  assert.equal(old.status, "retired");

  const store = await specialPlayerIdService.listStore({ limit: 100 });
  assert.equal(
    store.items.some((i) => i.number === 782),
    false,
    "it is gone from the store for good"
  );
  await assert.rejects(
    () => specialPlayerIdService.adminListOne({ number: 782, price: 1 }),
    /متقاعد|لم يعد/,
    "and an admin cannot put it back"
  );
});

test("the profile cache is invalidated so the buyer sees the new number", async () => {
  const playerProfileService = require("../services/playerProfileService");
  await listNumber(784, 1_000);
  const user = await makeUser({ balance: 50_000 });
  await playerIdService.ensurePlayerId(user._id);

  // Warm the 30s snapshot cache, the way opening the popup would.
  const before = await playerProfileService.getPublicProfile(user._id, user._id);
  assert.notEqual(before.identity.playerId, 784);

  await specialPlayerIdService.purchaseSpecialId({ userId: user._id, number: 784 });

  const after = await playerProfileService.getPublicProfile(user._id, user._id);
  assert.equal(
    after.identity.playerId,
    784,
    "without invalidate() this serves the old number for 30 seconds"
  );
});

/* ---------------------------------------------------------------- admin -- */

test("an admin placing a number above the ordinary floor bumps the counter", async () => {
  // Forget the bump and the allocator hands this same number to a future
  // signup, which the unique index then rejects at the worst moment.
  const user = await makeUser();
  const high = 9_000_000;

  await playerIdService.assignPlayerId({
    session: null,
    userId: user._id,
    number: high,
    reason: "admin_change",
  });
  await playerIdService.bumpCounterFloor(high);

  const next = await playerIdService.allocateNextOrdinaryId();
  assert.ok(next > high, `${next} > ${high}`);
});

test("assigning a held number is refused", async () => {
  const number = await playerIdService.allocateNextOrdinaryId();
  await makeUser({ playerId: number });
  const other = await makeUser();
  const before = await playerIdOf(other._id);

  await assert.rejects(
    () =>
      playerIdService.assignPlayerId({
        session: null,
        userId: other._id,
        number,
        reason: "admin_change",
      }),
    (err) => err.statusCode === 409
  );
  assert.equal(await playerIdOf(other._id), before);
});

/* ------------------------------------------------------------- backfill -- */

test("the backfill numbers existing users in join order and is repeatable", async () => {
  await User.deleteMany({ playerId: { $exists: false } });

  const base = Date.UTC(2020, 0, 1);
  // Inserted out of order on purpose: createdAt decides, not insertion.
  const third = await makeUser({ createdAt: new Date(base + 3000) });
  const first = await makeUser({ createdAt: new Date(base + 1000) });
  const second = await makeUser({ createdAt: new Date(base + 2000) });
  await User.updateMany(
    { _id: { $in: [first._id, second._id, third._id] } },
    { $unset: { playerId: "" } }
  );

  const run = await backfillPlayerIds({ log: () => {} });
  assert.equal(run.assigned, 3);

  const ids = await Promise.all([
    playerIdOf(first._id),
    playerIdOf(second._id),
    playerIdOf(third._id),
  ]);
  assert.ok(ids.every((n) => typeof n === "number"));
  assert.equal(ids[1], ids[0] + 1, "second joined after first");
  assert.equal(ids[2], ids[1] + 1, "third joined last");

  const rerun = await backfillPlayerIds({ log: () => {} });
  assert.equal(rerun.assigned, 0, "re-running changes nothing");
  assert.equal(await playerIdOf(first._id), ids[0], "and does not renumber");
});

test("the counter always sits above every number in use", async () => {
  const top = await User.findOne({ playerId: { $gte: 1001 } })
    .sort({ playerId: -1 })
    .select("playerId")
    .lean();
  const counter = await Counter.findById(playerIdService.COUNTER_KEY).lean();
  assert.ok(
    counter.seq >= (top?.playerId || 0),
    `counter ${counter.seq} >= highest assigned ${top?.playerId}`
  );
});
