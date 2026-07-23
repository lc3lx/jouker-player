"use strict";

/**
 * Clan treasury — donations must conserve coins (never mint or lose), respect the
 * minimum/daily limits, and keep the treasury balance non-negative.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanSettings = require("../models/clanSettingsModel");
const ClanTreasuryTransaction = require("../models/clanTreasuryTransactionModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const treasury = require("../services/clanTreasuryService");

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
const treasuryOf = async (c) => (await Clan.findById(c).lean())?.treasury?.balance ?? 0;

async function makeClan(tag) {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser("Owner", settings.creationCost + 100_000_000);
  const clan = await clanService.createClan(owner, { name: tag + " Clan", tag });
  return { owner, clanId: clan.id };
}

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "clan_treasury_test" });
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

test.beforeEach(async () => {
  await Promise.all([
    Clan.deleteMany({}),
    ClanMember.deleteMany({}),
    Wallet.deleteMany({}),
    User.deleteMany({}),
    ClanSettings.deleteMany({}),
    ClanTreasuryTransaction.deleteMany({}),
  ]);
  clanService.invalidateSettingsCache();
});

test("donation moves coins from member wallet to treasury exactly", async () => {
  const { clanId } = await makeClan("TRZ");
  const member = await makeUser("Member", 5_000_000);
  await membership.joinClan(member, clanId);

  const before = await balanceOf(member);
  const res = await treasury.donate(member, clanId, 1_000_000);

  assert.equal(res.balance, 1_000_000);
  assert.equal(await balanceOf(member), before - 1_000_000, "wallet debited exactly");
  assert.equal(await treasuryOf(clanId), 1_000_000, "treasury credited exactly");

  const m = await ClanMember.findOne({ clan: clanId, user: member }).lean();
  assert.equal(m.contribution.donated, 1_000_000);
  assert.equal(await ClanTreasuryTransaction.countDocuments({ clan: clanId, type: "donation" }), 1);
});

test("donation below the minimum is rejected", async () => {
  const { clanId } = await makeClan("MIN");
  const member = await makeUser("M", 5_000_000);
  await membership.joinClan(member, clanId);
  await assert.rejects(() => treasury.donate(member, clanId, 10), (e) => e.statusCode === 400);
  assert.equal(await treasuryOf(clanId), 0);
});

test("insufficient wallet → no donation, treasury untouched", async () => {
  const { clanId } = await makeClan("POR");
  const member = await makeUser("Poor", 500_000);
  await membership.joinClan(member, clanId);
  await assert.rejects(() => treasury.donate(member, clanId, 1_000_000), (e) => e.statusCode === 402);
  assert.equal(await balanceOf(member), 500_000, "wallet untouched");
  assert.equal(await treasuryOf(clanId), 0, "treasury untouched");
});

test("non-members cannot donate", async () => {
  const { clanId } = await makeClan("NMB");
  const outsider = await makeUser("Outsider", 5_000_000);
  await assert.rejects(() => treasury.donate(outsider, clanId, 1_000_000), (e) => e.statusCode === 403);
});

test("treasury debit cannot go negative", async () => {
  const { clanId } = await makeClan("NEG");
  await assert.rejects(
    () => treasury.adminAdjust(clanId, 1_000_000, "out"),
    (e) => e.statusCode === 402
  );
  // credit then debit within balance works
  await treasury.adminAdjust(clanId, 2_000_000, "in");
  const bal = await treasury.adminAdjust(clanId, 500_000, "out");
  assert.equal(bal, 1_500_000);
});
