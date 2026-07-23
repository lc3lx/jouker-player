"use strict";

/** Data-driven clan achievements: award when criteria met, idempotent, reward granted. */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Clan = require("../models/clanModel");
const ClanAchievementDef = require("../models/clanAchievementDefModel");
const ClanAchievement = require("../models/clanAchievementModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const achievements = require("../services/clanAchievementService");

let replSet = null;
const savedEnv = {};

async function makeClan(stats = {}) {
  const owner = new mongoose.Types.ObjectId();
  const clan = await Clan.create({
    name: "Test Clan",
    tag: "TST",
    owner,
    memberCount: 1,
    stats: { tournamentWins: 0, wins: 0, rankScore: 0, ...stats },
  });
  return clan;
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_ach_test" });
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
  await Promise.all([Clan.deleteMany({}), ClanAchievementDef.deleteMany({}), ClanAchievement.deleteMany({})]);
});

test("awards a met achievement once and credits the treasury reward", async () => {
  await ClanAchievementDef.create({
    key: "first_tournament",
    title: "First Tournament",
    criteria: { metric: "tournamentWins", op: "gte", threshold: 1 },
    rewardCoins: 100_000,
  });
  const clan = await makeClan({ tournamentWins: 1 });

  const awarded = await achievements.evaluateClan(clan._id);
  assert.equal(awarded.length, 1);
  assert.equal(awarded[0].key, "first_tournament");

  const fresh = await Clan.findById(clan._id).lean();
  assert.equal(fresh.treasury.balance, 100_000, "reward credited to treasury");
  assert.equal(await ClanAchievement.countDocuments({ clan: clan._id }), 1);

  // Idempotent — a second pass awards nothing and does not double-credit.
  const again = await achievements.evaluateClan(clan._id);
  assert.equal(again.length, 0);
  const still = await Clan.findById(clan._id).lean();
  assert.equal(still.treasury.balance, 100_000);
});

test("does not award when criteria unmet", async () => {
  await ClanAchievementDef.create({
    key: "champion",
    title: "Champion",
    criteria: { metric: "tournamentWins", op: "gte", threshold: 10 },
  });
  const clan = await makeClan({ tournamentWins: 3 });
  const awarded = await achievements.evaluateClan(clan._id);
  assert.equal(awarded.length, 0);
  assert.equal(await ClanAchievement.countDocuments({ clan: clan._id }), 0);
});

test("listAchievements reports earned and locked with progress", async () => {
  await ClanAchievementDef.create({ key: "a", title: "A", criteria: { metric: "wins", op: "gte", threshold: 5 } });
  await ClanAchievementDef.create({ key: "b", title: "B", criteria: { metric: "wins", op: "gte", threshold: 100 } });
  const clan = await makeClan({ wins: 5 });
  await achievements.evaluateClan(clan._id);
  const list = await achievements.listAchievements(clan._id);
  assert.equal(list.earned.length, 1);
  assert.equal(list.earned[0].key, "a");
  assert.equal(list.locked.length, 1);
  assert.equal(list.locked[0].current, 5);
});
