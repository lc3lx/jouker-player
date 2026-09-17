/**
 * Player-to-player coin gifting — the per-day, per-recipient allowance.
 *
 * Integration test over the real service + models against a throwaway local
 * MongoDB. Skipped automatically when no local Mongo is reachable, matching
 * test/friends.test.js.
 */
process.env.NODE_ENV = "test";
process.env.GIFT_COINS_MIN = "100";
process.env.GIFT_COINS_DAILY_PER_RECIPIENT = "100000";
process.env.ALLOW_NON_TRANSACTION_WALLET = "true";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const MONGO_URI = `mongodb://127.0.0.1:27017/gift_limit_test_${process.pid}`;
const LIMIT = 100000;

let mongoAvailable = false;
let User;
let Wallet;
let GiftDailyTotal;
let giftService;

let sender;
let recipient;
let other;

before(async () => {
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    mongoAvailable = true;
  } catch (_) {
    return;
  }
  User = require("../models/userModel");
  Wallet = require("../models/walletModel");
  GiftDailyTotal = require("../models/giftDailyTotalModel");
  giftService = require("../services/giftService");
  await GiftDailyTotal.syncIndexes();
});

after(async () => {
  if (!mongoAvailable) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let seq = 0;
async function makePlayer(balance = 0) {
  seq += 1;
  const user = await User.create({
    name: `gifter-${seq}`,
    email: `gifter-${seq}-${process.pid}@test.local`,
    password: "Passw0rd!",
  });
  await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
  return user;
}

beforeEach(async () => {
  if (!mongoAvailable) return;
  await GiftDailyTotal.deleteMany({});
  sender = await makePlayer(100_000_000);
  recipient = await makePlayer(0);
  other = await makePlayer(0);
});

function send(to, amount) {
  return giftService.sendGift({
    senderId: sender._id,
    targetId: to._id,
    type: "coins",
    amount,
  });
}

test("a gift within the daily allowance goes through", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  const res = await send(recipient, 40000);
  assert.equal(res.ok, true);
  assert.equal(res.amount, 40000);

  const row = await GiftDailyTotal.findOne({
    sender: sender._id,
    recipient: recipient._id,
  }).lean();
  assert.equal(row.coins, 40000);
});

test("gifts to one player stack until the daily limit, then stop", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  await send(recipient, 60000);
  await send(recipient, 40000); // exactly at the limit

  await assert.rejects(
    () => send(recipient, 100),
    (err) => err.statusCode === 429 && /daily gift limit/i.test(err.message),
  );

  const row = await GiftDailyTotal.findOne({
    sender: sender._id,
    recipient: recipient._id,
  }).lean();
  assert.equal(row.coins, LIMIT, "a refused gift must not consume allowance");
});

test("a single gift over the whole allowance is refused outright", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  await assert.rejects(
    () => send(recipient, LIMIT + 1),
    (err) => err.statusCode === 400 && /daily gift limit/i.test(err.message),
  );
});

test("the allowance is per recipient, not per sender", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  await send(recipient, LIMIT);
  // Same sender, different player — their own allowance is untouched.
  const res = await send(other, LIMIT);
  assert.equal(res.ok, true);
});

test("concurrent gifts cannot exceed the allowance between them", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  // A read-then-write check would let both of these see an empty bucket.
  const results = await Promise.allSettled([
    send(recipient, 80000),
    send(recipient, 80000),
  ]);
  const accepted = results.filter((r) => r.status === "fulfilled");
  assert.equal(accepted.length, 1, "only one of the two may land");

  const row = await GiftDailyTotal.findOne({
    sender: sender._id,
    recipient: recipient._id,
  }).lean();
  assert.ok(row.coins <= LIMIT, `bucket ${row.coins} must not exceed ${LIMIT}`);
});

test("a gift the sender cannot afford does not burn allowance", async (t) => {
  if (!mongoAvailable) return t.skip("no local mongo");
  const broke = await makePlayer(0);
  await assert.rejects(
    () =>
      giftService.sendGift({
        senderId: broke._id,
        targetId: recipient._id,
        type: "coins",
        amount: 50000,
      }),
    (err) => err.statusCode === 402,
  );

  const row = await GiftDailyTotal.findOne({
    sender: broke._id,
    recipient: recipient._id,
  }).lean();
  assert.ok(
    !row || row.coins === 0,
    "a failed transfer must hand the allowance back",
  );
});
