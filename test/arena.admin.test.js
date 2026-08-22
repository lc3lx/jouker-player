"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const ArenaTournament = require("../models/arenaTournamentModel");
const ArenaTournamentSettings = require("../models/arenaTournamentSettingsModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const catalog = require("../services/arenaTournamentCatalog");
const engine = require("../services/arenaTournamentEngineService");
const admin = require("../services/arenaTournamentAdminService");

const OWNER_BAL = catalog.CREATE_FEE + 50_000;
const ADMIN_ID = new mongoose.Types.ObjectId();

let replSet = null;
const savedEnv = {};

function mkReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query, user: { _id: ADMIN_ID, name: "Admin" }, ip: "127.0.0.1", get: () => "test" };
}
function mkRes() {
  const res = {
    statusCode: 200,
    payload: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(p) {
      this.payload = p;
      return this;
    },
  };
  return res;
}
async function run(handler, req) {
  const res = mkRes();
  let err = null;
  await handler(req, res, (e) => {
    err = e;
  });
  if (err) throw err;
  return res;
}

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}

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
  await mongoose.connect(replSet.getUri(), { dbName: "arena_admin_test" });
});

test.after(async () => {
  engine.stopEngine();
  catalog.applyOverrides({});
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
  catalog.applyOverrides({});
  await Promise.all([
    Wallet.deleteMany({}),
    User.deleteMany({}),
    ArenaTournament.deleteMany({}),
    ArenaTournamentSettings.deleteMany({}),
    mongoose.connection.collection("tables").deleteMany({}).catch(() => {}),
    mongoose.connection.collection("players").deleteMany({}).catch(() => {}),
    mongoose.connection.collection("wallettransactions").deleteMany({}).catch(() => {}),
  ]);
});

test("admin can change house catalog name and price", async () => {
  const res = await run(admin.adminUpdateCatalogTier, mkReq({
    params: { tierId: "mini" },
    body: { nameAr: "كأس البيت", entryFee: 777 },
  }));
  assert.equal(res.payload.status, "success");
  const mini = catalog.serializeCatalog().tiers.find((t) => t.id === "mini");
  assert.equal(mini.nameAr, "كأس البيت");
  assert.equal(mini.entryFee, 777);
});

test("admin can rename and reprice a registering empty tournament", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const t = await engine.createTournament(owner, {
    game: "poker",
    name: "Old Cup",
    type: "paid",
    entryFee: 500,
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  const res = await run(admin.adminUpdateTournament, mkReq({
    params: { id: t.id },
    body: { name: "كأس الأدمن", entryFee: 900 },
  }));
  assert.equal(res.payload.data.name, "كأس الأدمن");
  assert.equal(res.payload.data.entryFee, 900);
  const doc = await ArenaTournament.findById(t.id).lean();
  assert.equal(doc.adminEdited, true);
});

test("admin cannot change price after players registered", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const player = await makeUser("P1", 10_000);
  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "paid",
    entryFee: 500,
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  await engine.register(player, t.id);
  await assert.rejects(
    () =>
      run(admin.adminUpdateTournament, mkReq({
        params: { id: t.id },
        body: { entryFee: 50 },
      })),
    (e) => e.statusCode === 409
  );
});

test("admin can end a registering tournament and refund", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const player = await makeUser("P1", 10_000);
  const t = await engine.createTournament(owner, {
    game: "trix",
    type: "paid",
    entryFee: 1000,
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  await engine.register(player, t.id);
  await run(admin.adminEndTournament, mkReq({
    params: { id: t.id },
    body: { reason: "admin" },
  }));
  const doc = await ArenaTournament.findById(t.id).lean();
  assert.equal(doc.lifecycle, "cancelled");
  assert.equal((await Wallet.findOne({ user: player }).lean()).balance, 10_000);
});

test("admin cannot start or end a running tournament with players", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "friendly",
    maxPlayers: 8,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  const tableId = new mongoose.Types.ObjectId();
  await ArenaTournament.updateOne(
    { _id: t.id },
    {
      $set: {
        lifecycle: "running",
        startedAt: new Date(),
        tableIds: [tableId],
        participants: [{ user: owner, tableId, escrow: 0 }],
      },
    }
  );

  await assert.rejects(
    () => run(admin.adminStartTournament, mkReq({ params: { id: t.id } })),
    (e) => e.statusCode === 409
  );
  await assert.rejects(
    () => run(admin.adminEndTournament, mkReq({ params: { id: t.id } })),
    (e) => e.statusCode === 409
  );
  await assert.rejects(
    () =>
      run(admin.adminUpdateTournament, mkReq({
        params: { id: t.id },
        body: { name: "لا" },
      })),
    (e) => e.statusCode === 409
  );
});

test("admin start rejects when not enough players", async () => {
  const owner = await makeUser("Owner", OWNER_BAL);
  const t = await engine.createTournament(owner, {
    game: "poker",
    type: "friendly",
    maxPlayers: 8,
    minPlayers: 4,
    durationMinutes: 4,
    startAt: startSoon(),
  });
  await assert.rejects(
    () => run(admin.adminStartTournament, mkReq({ params: { id: t.id } })),
    (e) => e.statusCode === 409
  );
});
