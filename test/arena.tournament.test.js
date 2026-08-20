"use strict";

/**
 * Public arena tournaments — transactional create/register/refund/payout,
 * 2-hour house catalog, and coin conservation. Independent of the disabled
 * legacy Tournament collection.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const ArenaTournament = require("../models/arenaTournamentModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const catalog = require("../services/arenaTournamentCatalog");
const engine = require("../services/arenaTournamentEngineService");

/** Owners need enough coins to cover CREATE_FEE (5M) plus leftover asserts. */
const OWNER_BAL = catalog.CREATE_FEE + 50_000;

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;

function startSoon() {
  return new Date(Date.now() + 2 * 60 * 1000).toISOString();
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
  await mongoose.connect(replSet.getUri(), { dbName: "arena_tournament_test" });
});

test.after(async () => {
  engine.stopEngine();
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
    Wallet.deleteMany({}),
    User.deleteMany({}),
    ArenaTournament.deleteMany({}),
    mongoose.connection.collection("tables").deleteMany({}).catch(() => {}),
    mongoose.connection.collection("players").deleteMany({}).catch(() => {}),
    mongoose.connection.collection("wallettransactions").deleteMany({}).catch(() => {}),
  ]);
});

test("catalog exposes 5 tiers and 4/8/12 round lengths", () => {
  const data = catalog.serializeCatalog();
  assert.equal(data.tiers.length, 5);
  assert.deepEqual(data.durations, [4, 8, 12]);
  assert.deepEqual(data.rounds, [4, 8, 12]);
  assert.equal(data.tiers[0].nameAr, "صغيرة");
  assert.equal(data.tiers[1].nameAr, "أكبر بشوي");
  assert.equal(data.tiers[2].nameAr, "أكبر");
  assert.equal(data.tiers[3].nameAr, "أكبر بكثير");
  assert.equal(data.tiers[4].nameAr, "الأكبر");
  assert.ok(data.tiers.every((t) => [4, 8, 12].includes(t.rounds)));
  assert.equal(data.createFee, catalog.CREATE_FEE);
  assert.equal(data.slotMs, 2 * 60 * 60 * 1000);
  assert.ok(data.tiers.every((t) => t.guaranteedPrize > 0 && t.entryFee > 0));
});

test("creating a tournament charges the create fee", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const t = await engine.createTournament(owner, {
    game: "poker",
    name: "Test Cup",
    type: "paid",
    entryFee: 500,
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  assert.equal(t.origin, "player");
  assert.equal(await balanceOf(owner), OWNER_BAL - catalog.CREATE_FEE);
  const doc = await ArenaTournament.findById(t.id).lean();
  assert.equal(doc.createFee, catalog.CREATE_FEE);
  assert.equal(doc.lifecycle, "registering");
});

test("register / unregister refunds the entry fee transactionally", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const player = await makeUser("P1", 10_000);
  const t = await engine.createTournament(owner, {
    game: "trix",
    type: "paid",
    entryFee: 1000,
    maxPlayers: 8,
    durationMinutes: 8,
    startAt: startSoon(),
  });
  await engine.register(player, t.id);
  assert.equal(await balanceOf(player), 9000);
  const mid = await ArenaTournament.findById(t.id).lean();
  assert.equal(mid.escrowHeld, 1000);
  assert.equal(mid.prizePool, 1000);
  const res = await engine.unregister(player, t.id);
  assert.equal(res.refunded, 1000);
  assert.equal(await balanceOf(player), 10_000);
  const after = await ArenaTournament.findById(t.id).lean();
  assert.equal(after.participants.length, 0);
  assert.equal(after.escrowHeld, 0);
});

test("cancel refunds all entry fees but keeps the create fee", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const a = await makeUser("A", 5000);
  const b = await makeUser("B", 5000);
  const t = await engine.createTournament(owner, {
    game: "tarneeb41",
    type: "paid",
    entryFee: 500,
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  await engine.register(a, t.id);
  await engine.register(b, t.id);
  const beforeA = await balanceOf(a);
  const beforeB = await balanceOf(b);
  await engine.cancelTournament(t.id, "test", { actorId: owner });
  const doc = await ArenaTournament.findById(t.id).lean();
  assert.equal(doc.lifecycle, "cancelled");
  assert.equal(await balanceOf(a), beforeA + 500);
  assert.equal(await balanceOf(b), beforeB + 500);
  assert.equal(await balanceOf(owner), OWNER_BAL - catalog.CREATE_FEE);
});

test("paid finish pays the whole escrow and conserves coins", async () => {
  const FEE = 1000;
  const owner = await makeUser("Owner", OWNER_BAL);
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await makeUser("P" + i, 10_000));

  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "paid",
    entryFee: FEE,
    maxPlayers: 8,
    minPlayers: 4,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  for (const p of players) await engine.register(p, t.id);

  const before = {};
  for (const p of players) before[String(p)] = await balanceOf(p);

  await engine.startTournament(t.id);
  await ArenaTournament.updateOne({ _id: t.id }, { $set: { gamesCompleted: 1 } });
  const running = await ArenaTournament.findById(t.id);
  running.participants.forEach((p, i) => {
    p.tournamentScore = (3 - i) * 100;
  });
  await running.save();
  await engine.finishTournament(t.id);

  const finished = await ArenaTournament.findById(t.id).lean();
  assert.equal(finished.lifecycle, "finished");
  assert.equal(finished.prizePaid, FEE * 4);

  let prizeSum = 0;
  for (const p of players) {
    prizeSum += (await balanceOf(p)) - before[String(p)];
  }
  assert.equal(prizeSum, FEE * 4);
});

test("heat ends after target rounds, not after a few minutes", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await makeUser("R" + i, 10_000));
  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "paid",
    entryFee: 500,
    maxPlayers: 8,
    minPlayers: 4,
    rounds: 4,
    startAt: startSoon(),
  });
  for (const p of players) await engine.register(p, t.id);
  await engine.startTournament(t.id);
  const running = await ArenaTournament.findById(t.id).lean();
  assert.equal(running.durationMinutes, 4);
  assert.ok(running.endsAt.getTime() - Date.now() > 60 * 60 * 1000, "safety window is hours, not minutes");
  await ArenaTournament.updateOne(
    { _id: t.id },
    { $set: { gamesCompleted: 4, "participants.0.tournamentScore": 400 } }
  );
  await engine.tick();
  const finished = await ArenaTournament.findById(t.id).lean();
  assert.equal(finished.lifecycle, "finished");
});

test("house names use round labels", () => {
  const name = catalog.houseName("poker", catalog.TIERS[0]);
  assert.match(name, /جولات/);
  assert.match(name, /صغيرة/);
  assert.equal(name.includes(" د"), false);
});

test("house schedule is idempotent across 3 games × 5 tiers", async () => {
  await engine.ensureSchedule();
  const n1 = await ArenaTournament.countDocuments({ origin: "house" });
  assert.equal(n1, 3 * 5 * 2);
  await engine.ensureSchedule();
  const n2 = await ArenaTournament.countDocuments({ origin: "house" });
  assert.equal(n2, n1);
  const keys = await ArenaTournament.distinct("slotKey", { origin: "house" });
  assert.equal(keys.length, n1);
});

test("private tournaments are hidden from strangers", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const stranger = await makeUser("Str", 5000);
  const t = await engine.createTournament(owner, {
    game: "poker",
    visibility: "private",
    type: "friendly",
    durationMinutes: 4,
    maxPlayers: 8,
    startAt: startSoon(),
  });
  const lobby = await engine.listLobby(stranger);
  assert.equal(lobby.some((row) => row.id === t.id), false);
  await assert.rejects(() => engine.getDetail(t.id, stranger), (e) => e.statusCode === 404);
  const mine = await engine.listLobby(owner);
  assert.equal(mine.some((row) => row.id === t.id), true);
});

test("insufficient coins cannot create or register", async () => {
  const broke = await makeUser("Broke", 10);
  await assert.rejects(
    () =>
      engine.createTournament(broke, {
        game: "poker",
        type: "friendly",
        durationMinutes: 4,
        startAt: startSoon(),
      }),
    (e) => e.statusCode === 402
  );
  const owner = await makeUser("Owner", OWNER_BAL);
  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "paid",
    entryFee: 5000,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  await assert.rejects(() => engine.register(broke, t.id), (e) => e.statusCode === 402);
});
