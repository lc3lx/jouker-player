"use strict";

/**
 * Clan chat gating — only active members may post to a clan channel; system
 * messages (join/leave/promotion/tournament) bypass gating and are flagged.
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
const ChatMessage = require("../models/chatMessageModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const chatService = require("../services/chatService");

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}

async function makeClan(tag) {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser("Owner", settings.creationCost + 1);
  const clan = await clanService.createClan(owner, { name: `${tag} Clan`, tag });
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_chat_test" });
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
    ChatMessage.deleteMany({}),
  ]);
  clanService.invalidateSettingsCache();
});

test("a member can post to their clan channel", async () => {
  const { owner, clanId } = await makeClan("CHT");
  const msg = await chatService.sendMessage({
    senderId: owner,
    channel: "clan",
    channelId: clanId,
    body: "مرحباً بالجميع",
  });
  assert.equal(msg.channel, "clan");
  assert.equal(String(msg.channelId), String(clanId));

  const history = await chatService.getHistory({ channel: "clan", channelId: clanId });
  assert.equal(history.length, 1);
  assert.equal(history[0].body, "مرحباً بالجميع");
});

test("a non-member cannot post to a clan channel", async () => {
  const { clanId } = await makeClan("GAT");
  const outsider = await makeUser("Outsider");
  await assert.rejects(
    () =>
      chatService.sendMessage({
        senderId: outsider,
        channel: "clan",
        channelId: clanId,
        body: "دعوني أدخل",
      }),
    (e) => e.statusCode === 403
  );
  assert.equal(await ChatMessage.countDocuments({ channel: "clan" }), 0);
});

test("a kicked member can no longer post", async () => {
  const { owner, clanId } = await makeClan("KIK");
  const member = await makeUser("Member");
  await membership.joinClan(member, clanId);

  // Allowed while a member.
  await chatService.sendMessage({
    senderId: member,
    channel: "clan",
    channelId: clanId,
    body: "أهلاً",
  });

  await membership.kickMember(owner, clanId, member);
  await assert.rejects(
    () =>
      chatService.sendMessage({
        senderId: member,
        channel: "clan",
        channelId: clanId,
        body: "ما زلت هنا؟",
      }),
    (e) => e.statusCode === 403
  );
});

test("system messages bypass membership gating and are flagged", async () => {
  const { clanId } = await makeClan("SYS");
  const stranger = await makeUser("Stranger");

  // A system line about someone who already left must still persist.
  const msg = await chatService.sendSystemMessage({
    channel: "clan",
    channelId: clanId,
    actorId: stranger,
    body: "غادر أحد الأعضاء العشيرة",
    meta: { event: "leave" },
  });
  assert.equal(msg.meta.system, true);
  assert.equal(msg.meta.event, "leave");

  const history = await chatService.getHistory({ channel: "clan", channelId: clanId });
  assert.equal(history.length, 1);
  assert.equal(history[0].meta.system, true);
});

test("joining a clan posts a system message to its channel", async () => {
  const { clanId } = await makeClan("JOI");
  const member = await makeUser("Joiner");
  await membership.joinClan(member, clanId);

  // systemChat is fire-and-forget; give it a tick to land.
  await new Promise((r) => setTimeout(r, 120));
  const rows = await ChatMessage.find({ channel: "clan", channelId: String(clanId) }).lean();
  assert.ok(
    rows.some((r) => r.meta && r.meta.system && r.meta.event === "join"),
    "join system message persisted"
  );
});

test("clan messages are isolated per clan channel", async () => {
  const a = await makeClan("AAA");
  const b = await makeClan("BBB");
  await chatService.sendMessage({
    senderId: a.owner,
    channel: "clan",
    channelId: a.clanId,
    body: "رسالة عشيرة أ",
  });
  const bHistory = await chatService.getHistory({ channel: "clan", channelId: b.clanId });
  assert.ok(
    !bHistory.some((m) => m.body === "رسالة عشيرة أ"),
    "clan B cannot see clan A messages"
  );
});
