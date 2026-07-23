"use strict";

/**
 * Bot identity pool + admin surface — persistent bot Users, acquire/release,
 * uniqueness then graceful reuse, the isBotUser registry, and the admin CRUD/
 * config/audit surface. Real Mongo replica set.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const BotSettings = require("../models/botSettingsModel");
const AuditLog = require("../models/auditLogModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const botPoolService = require("../services/botPoolService");
const admin = require("../services/botAdminService");

let replSet = null;
const savedEnv = {};
const ADMIN_ID = new mongoose.Types.ObjectId();

async function makeBot(name, extra = {}) {
  const u = await User.create({
    name,
    email: `${new mongoose.Types.ObjectId()}@bots.local`,
    password: "secret123",
    isBot: true,
    profileImg: "bot_avatar_01",
    preferences: { language: "ar" },
    bot: { personality: "professional", skill: "normal", enabled: true, inUse: false, ...extra },
  });
  return u._id;
}

function mkReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query, user: { _id: ADMIN_ID }, ip: "127.0.0.1", get: () => "test" };
}
async function runAdmin(handler, req) {
  const res = {
    statusCode: 200,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  let err = null;
  await handler(req, res, (e) => { err = e; });
  if (err) throw err;
  return res;
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
  await mongoose.connect(replSet.getUri(), { dbName: "bots_identity_test" });
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
    User.deleteMany({}), Wallet.deleteMany({}), Player.deleteMany({}),
    BotSettings.deleteMany({}), AuditLog.deleteMany({}),
  ]);
  botPoolService._reset();
});

test("pool loads persistent bots and acquire returns a real identity", async () => {
  const id = await makeBot("Khalid", { personality: "aggressive", skill: "hard" });
  await botPoolService.refresh();

  const identity = botPoolService.acquire([]);
  assert.ok(identity, "an identity was acquired");
  assert.equal(identity.userId, String(id));
  assert.equal(identity.name, "Khalid");
  assert.equal(identity.personality, "aggressive");
  assert.ok(identity.tuning && identity.tuning.raiseMul > 1, "tuning attached");
  assert.equal(botPoolService.isBotUser(String(id)), true, "registry recognizes the bot");
});

test("acquire is unique per table, and reuses across tables when exhausted", async () => {
  await makeBot("A");
  await makeBot("B");
  await botPoolService.refresh();

  // Table 1 seats two distinct bots.
  const seated1 = [];
  const id1 = botPoolService.acquire(seated1);
  seated1.push(id1.userId);
  const id2 = botPoolService.acquire(seated1);
  seated1.push(id2.userId);
  assert.notEqual(id1.userId, id2.userId, "two seats at one table get distinct bots");

  // A 3rd seat at the SAME table can't get a unique/reused bot (both already here)
  // → null, so the caller falls back to a synthetic bot (no dup at one table).
  assert.equal(botPoolService.acquire(seated1), null, "no duplicate bot at the same table");

  // A DIFFERENT table (nothing excluded) reuses an already-seated bot so hundreds
  // of tables still fill from a small pool.
  const id3 = botPoolService.acquire([]);
  assert.ok(id3, "cross-table reuse returns an identity when the pool is exhausted");
});

test("release frees a bot for reuse", async () => {
  await makeBot("Solo");
  await botPoolService.refresh();
  const id = botPoolService.acquire([]);
  botPoolService.release(id.userId);
  const again = botPoolService.acquire([]);
  assert.equal(again.userId, id.userId, "released bot can be acquired again");
});

test("isBotUser recognizes persistent bots AND legacy synthetic ids", async () => {
  const id = await makeBot("Reg");
  await botPoolService.refresh();
  assert.equal(botPoolService.isBotUser(String(id)), true);
  assert.equal(botPoolService.isBotUser("bot:table:1:2"), true, "legacy poker id");
  assert.equal(botPoolService.isBotUser("bot_fill_123_0"), true, "legacy card id");
  assert.equal(botPoolService.isBotUser(String(new mongoose.Types.ObjectId())), false, "a random user is not a bot");
});

test("disabled bots are excluded from the pool", async () => {
  await makeBot("On", { enabled: true });
  await makeBot("Off", { enabled: false });
  await botPoolService.refresh();
  assert.equal(botPoolService.count(), 1, "only the enabled bot is poolable");
});

// ── admin surface ─────────────────────────────────────────────────────────────

test("admin can create, list, update, disable and delete a bot", async () => {
  const created = await runAdmin(admin.adminCreateBot, mkReq({ body: { name: "NewBot", personality: "risky", skill: "hard", balance: 1234000 } }));
  assert.equal(created.statusCode, 201);
  const botId = created.payload.data.id;
  assert.equal(created.payload.data.personality, "risky");
  assert.equal(created.payload.data.balance, 1234000);

  const list = await runAdmin(admin.adminListBots, mkReq({}));
  assert.ok(list.payload.data.some((b) => b.id === botId), "bot appears in the list");

  const upd = await runAdmin(admin.adminUpdateBot, mkReq({ params: { id: botId }, body: { name: "Renamed", skill: "expert" } }));
  assert.equal(upd.payload.data.name, "Renamed");
  assert.equal(upd.payload.data.skill, "expert");

  await runAdmin(admin.adminSetBotEnabled, mkReq({ params: { id: botId }, body: { enabled: false } }));
  const disabled = await User.findById(botId).lean();
  assert.equal(disabled.bot.enabled, false);

  await runAdmin(admin.adminDeleteBot, mkReq({ params: { id: botId } }));
  assert.equal(await User.countDocuments({ _id: botId }), 0, "bot deleted");
  assert.equal(await Wallet.countDocuments({ user: botId }), 0, "wallet cleaned up");

  // Every admin action is audited.
  await new Promise((r) => setTimeout(r, 150));
  const events = (await AuditLog.find({}).lean()).map((e) => e.event);
  for (const ev of ["admin_bot_create", "admin_bot_update", "admin_bot_set_enabled", "admin_bot_delete"]) {
    assert.ok(events.includes(ev), `audit entry for ${ev}`);
  }
});

test("admin config update persists and validates", async () => {
  const res = await runAdmin(admin.adminUpdateConfig, mkReq({ body: { botsEnabled: false, maxBotsPerTable: 3, chatFrequency: 0.5 } }));
  assert.equal(res.payload.data.botsEnabled, false);
  assert.equal(res.payload.data.maxBotsPerTable, 3);
  const s = await BotSettings.getDefaults();
  assert.equal(s.chatFrequency, 0.5, "persisted");
});

test("admin rejects an invalid personality on update", async () => {
  const id = String(await makeBot("X"));
  await assert.rejects(
    () => runAdmin(admin.adminUpdateBot, mkReq({ params: { id }, body: { personality: "nonsense" } })),
    (e) => e.statusCode === 400
  );
});
