"use strict";

/**
 * The daily bonus: what a player gets for showing up.
 *
 * Everyone gets the base. A VIP gets their level's `dailyChips` instead — but
 * only when that is actually larger, because those numbers are typed in by hand
 * in the admin panel and a level left at zero would otherwise make paying for
 * VIP a downgrade.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const VIPSubscription = require("../models/vipSubscriptionModel");
const ledger = require("../services/walletLedgerService");
const statsService = require("../services/statsService");
const { dailyBonusBaseChips } = require("../utils/appConfig");

let replSet = null;
const savedEnv = {};
let seq = 0;

async function makeUser() {
  seq += 1;
  const user = await User.create({
    name: `لاعب ${seq}`,
    email: `db${seq}.${Date.now()}@test.local`,
    password: "x".repeat(12),
  });
  await Wallet.create({ user: user._id, balance: 0, lockedBalance: 0 });
  return user;
}

test.before(async () => {
  for (const k of [
    "MONGODB_URI",
    "MONGO_URI",
    "DB_URI",
    "MONGO_STANDALONE",
    "DAILY_BONUS_CHIPS",
    "BETA_BONUS_MULTIPLIER",
  ]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.MONGO_STANDALONE;
  // Pin the amount so the assertions below are about the rule, not the config.
  process.env.DAILY_BONUS_CHIPS = "50000";
  process.env.BETA_BONUS_MULTIPLIER = "1";

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  ledger.resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "daily_bonus_test" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  ledger.resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("the default base is 50,000", () => {
  // The number the product asked for. It shipped at 2,500.
  assert.equal(dailyBonusBaseChips(), 50_000);
});

test("an ordinary player gets the base", async () => {
  const user = await makeUser();
  const grant = await statsService.resolveDailyBonusGrant(user._id, 50_000);

  assert.equal(grant.amount, 50_000);
  assert.equal(grant.isVip, false);
  assert.equal(grant.vipApplied, false);
});

test("a VIP whose level pays more gets their amount", async () => {
  const user = await makeUser();
  const { vipLevelConfig } = require("../config/vipConfig");

  // Find a configured level that actually pays more than the base; if the
  // config has none, this rule has nothing to assert on.
  const levels = ["bronze", "silver", "gold", "platinum", "diamond"];
  const richer = levels.find((l) => (vipLevelConfig(l)?.dailyChips || 0) > 50_000);
  if (!richer) return; // no such level configured

  await VIPSubscription.create({
    userId: String(user._id),
    currentLevel: richer,
    status: "active",
    startDate: new Date(),
    expireDate: new Date(Date.now() + 86400000 * 30),
  });

  const grant = await statsService.resolveDailyBonusGrant(user._id, 50_000);
  assert.equal(grant.isVip, true);
  assert.equal(grant.vipLevel, richer);
  assert.equal(grant.amount, vipLevelConfig(richer).dailyChips);
  assert.equal(grant.vipApplied, true);
});

test("a VIP level configured below the base never pays less than free", async () => {
  // The case that matters most: these amounts are typed in by an admin. A
  // level left at 0 or set to 1,000 must not make a paying customer worse off
  // than somebody who paid nothing.
  const user = await makeUser();
  await VIPSubscription.create({
    userId: String(user._id),
    currentLevel: "bronze",
    status: "active",
    startDate: new Date(),
    expireDate: new Date(Date.now() + 86400000 * 30),
  });

  const grant = await statsService.resolveDailyBonusGrant(user._id, 999_999_999);

  assert.equal(grant.isVip, true);
  assert.equal(
    grant.amount,
    999_999_999,
    "the higher of the two wins, always"
  );
  assert.equal(grant.vipApplied, false, "and the client is told VIP did nothing");
});

test("an expired subscription is not VIP", async () => {
  const user = await makeUser();
  await VIPSubscription.create({
    userId: String(user._id),
    currentLevel: "gold",
    status: "active",
    startDate: new Date(),
    expireDate: new Date(Date.now() - 86400000),
  });

  const grant = await statsService.resolveDailyBonusGrant(user._id, 50_000);
  assert.equal(grant.isVip, false);
  assert.equal(grant.amount, 50_000);
});

test("claiming pays out and cannot be repeated the same day", async () => {
  const user = await makeUser();
  const res1 = await claim(user._id);

  assert.equal(res1.status, 200);
  assert.ok(res1.body.data.granted >= 50_000, "at least the base");
  assert.equal(res1.body.data.dailyBonusStreak, 1);

  const credited = await WalletTransaction.findOne({
    userId: user._id,
    "meta.source": "daily_bonus",
  }).lean();
  assert.ok(credited, "the grant is on the ledger");
  assert.equal(credited.amount, res1.body.data.granted);

  const wallet = await Wallet.findOne({ user: user._id }).lean();
  assert.equal(wallet.balance, res1.body.data.granted);

  // Once per UTC day, whatever the fraud ceiling happens to be configured at.
  // This guard used to apply only in production mode, so on a server running
  // in any other mode the bonus could be taken three times a day.
  const res2 = await claim(user._id);
  assert.equal(res2.error?.statusCode, 400, "a second claim today is refused");
  const after = await Wallet.findOne({ user: user._id }).lean();
  assert.equal(after.balance, wallet.balance, "and pays nothing");

  const res3 = await claim(user._id);
  assert.equal(res3.error?.statusCode, 400, "and a third");
  assert.equal(
    await WalletTransaction.countDocuments({
      userId: user._id,
      "meta.source": "daily_bonus",
    }),
    1,
    "exactly one grant reached the ledger"
  );
});

test("the status endpoint reports availability without paying", async () => {
  const user = await makeUser();

  const before = await status(user._id);
  assert.equal(before.body.data.available, true);
  assert.equal(before.body.data.claimedToday, false);
  assert.equal(before.body.data.amount, 50_000);
  assert.equal(
    (await Wallet.findOne({ user: user._id }).lean()).balance,
    0,
    "checking is not claiming"
  );

  await claim(user._id);

  const after = await status(user._id);
  assert.equal(after.body.data.available, false);
  assert.equal(after.body.data.claimedToday, true);
});

/* ---------------------------------------------------------------- harness -- */

function run(handler, userId) {
  return new Promise((resolve, reject) => {
    const req = { user: { _id: userId }, body: {}, query: {} };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    const next = (err) => resolve({ error: err, status: err?.statusCode });
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const claim = (userId) => run(statsService.claimDailyBonus, userId);
const status = (userId) => run(statsService.getDailyBonusStatus, userId);
