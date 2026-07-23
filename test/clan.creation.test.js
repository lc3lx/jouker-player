"use strict";

/**
 * Clan creation — money-critical path.
 * Verifies: atomic cost deduction, one-clan-per-player (unique index), insufficient
 * funds → NO clan + NO deduction, duplicate tag rejection, owner membership + denorm.
 * Runs on a real Mongo replica set (transactions supported).
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
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const clanService = require("../services/clanService");

let replSet = null;
const savedEnv = {};

async function makeUser(balance, name = "Player") {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "clan_creation_test" });
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
  ]);
  clanService.invalidateSettingsCache();
});

test("successful creation deducts exactly the creation cost and seats owner", async () => {
  const settings = await ClanSettings.getDefaults();
  const cost = settings.creationCost;
  const uid = await makeUser(cost + 5_000_000);

  const clan = await clanService.createClan(uid, {
    name: "Night Owls",
    tag: "OWL",
    joinType: "public",
    country: "SA",
  });

  assert.equal(clan.tag, "OWL");
  assert.equal(clan.viewer.role, "owner");
  assert.equal(await balanceOf(uid), 5_000_000, "cost deducted exactly");

  const member = await ClanMember.findOne({ user: uid }).lean();
  assert.equal(member.role, "owner");

  const user = await User.findById(uid).lean();
  assert.equal(user.clan.tag, "OWL");
  assert.equal(user.clan.role, "owner");
  assert.ok(user.clan.id, "denorm clan id set");

  const dbClan = await Clan.findById(clan.id).lean();
  assert.equal(dbClan.memberCount, 1);
});

test("a player already in a clan cannot create a second one (no deduction)", async () => {
  const settings = await ClanSettings.getDefaults();
  const uid = await makeUser(settings.creationCost * 3);
  await clanService.createClan(uid, { name: "First", tag: "AAA" });
  const balAfterFirst = await balanceOf(uid);

  await assert.rejects(
    () => clanService.createClan(uid, { name: "Second", tag: "BBB" }),
    (e) => e.statusCode === 409
  );
  assert.equal(await balanceOf(uid), balAfterFirst, "no second deduction");
  assert.equal(await Clan.countDocuments({ tag: "BBB" }), 0, "second clan not created");
});

test("insufficient funds → clan NOT created and NO coins moved", async () => {
  const settings = await ClanSettings.getDefaults();
  const uid = await makeUser(settings.creationCost - 1);

  await assert.rejects(
    () => clanService.createClan(uid, { name: "Broke", tag: "POOR" }),
    (e) => e.statusCode === 402
  );
  assert.equal(await balanceOf(uid), settings.creationCost - 1, "balance untouched");
  assert.equal(await Clan.countDocuments({ tag: "POOR" }), 0);
  assert.equal(await ClanMember.countDocuments({ user: uid }), 0);
});

test("duplicate tag is rejected", async () => {
  const settings = await ClanSettings.getDefaults();
  const a = await makeUser(settings.creationCost * 2);
  const b = await makeUser(settings.creationCost * 2);
  await clanService.createClan(a, { name: "Alpha", tag: "DUP" });
  await assert.rejects(
    () => clanService.createClan(b, { name: "Beta", tag: "dup" }),
    (e) => e.statusCode === 409
  );
});

test("invalid tag length is rejected before any charge", async () => {
  const settings = await ClanSettings.getDefaults();
  const uid = await makeUser(settings.creationCost * 2);
  await assert.rejects(
    () => clanService.createClan(uid, { name: "BadTag", tag: "TOOLONGTAG" }),
    (e) => e.statusCode === 400
  );
  assert.equal(await balanceOf(uid), settings.creationCost * 2, "no charge on validation failure");
});
