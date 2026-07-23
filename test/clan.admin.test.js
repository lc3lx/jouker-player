"use strict";

/**
 * Admin clan surface + leaderboards + badge lookups.
 * Admin handlers are Express middlewares, so they're driven here with tiny
 * req/res fakes (the same shape the real router passes).
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
const admin = require("../services/clanAdminService");
const leaderboard = require("../services/clanLeaderboardService");
const badges = require("../services/clanBadgeService");

let replSet = null;
const savedEnv = {};
const ADMIN_ID = new mongoose.Types.ObjectId();

/** Minimal Express req/res doubles. */
function mkReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query, user: { _id: ADMIN_ID }, ip: "127.0.0.1", get: () => "test" };
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
/** Run an asyncHandler-wrapped controller and surface thrown ApiErrors. */
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_admin_test" });
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

// ─── admin moderation ─────────────────────────────────────────────────────────

test("admin can ban a clan and restore it", async () => {
  const { clanId } = await makeClan("BAN");

  const banned = await run(admin.adminBanClan, mkReq({ params: { id: clanId }, body: { reason: "abuse" } }));
  assert.equal(banned.payload.data.status, "banned");
  let doc = await Clan.findById(clanId).lean();
  assert.equal(doc.status, "banned");
  assert.equal(doc.bannedReason, "abuse");

  // A banned clan disappears from public browsing.
  const browse = await clanService.browseClans({});
  assert.equal(browse.data.some((c) => c.id === clanId), false, "banned clan hidden from browse");

  const restored = await run(admin.adminRestoreClan, mkReq({ params: { id: clanId } }));
  assert.equal(restored.payload.data.status, "active");
  doc = await Clan.findById(clanId).lean();
  assert.equal(doc.status, "active");
  assert.equal(doc.bannedReason, null);
});

test("admin config update changes the live creation cost", async () => {
  const res = await run(
    admin.adminUpdateConfig,
    mkReq({ body: { creationCost: 250, maxMembersDefault: 7 } })
  );
  assert.equal(res.payload.data.creationCost, 250);

  // The cache was invalidated, so a new clan is charged the new price.
  const settings = await clanService.getSettings();
  assert.equal(settings.creationCost, 250);

  const uid = await makeUser("Cheap", 1000);
  await clanService.createClan(uid, { name: "Cheap Clan", tag: "CHP" });
  const wallet = await Wallet.findOne({ user: uid }).lean();
  assert.equal(wallet.balance, 750, "charged the admin-configured cost");

  const clan = await Clan.findOne({ tag: "CHP" }).lean();
  assert.equal(clan.maxMembers, 7, "new clans use the configured member cap");
});

test("admin treasury adjustment credits and debits", async () => {
  const { clanId } = await makeClan("TRS");
  const credited = await run(
    admin.adminAdjustTreasury,
    mkReq({ params: { id: clanId }, body: { amount: 5000, direction: "in" } })
  );
  assert.equal(credited.payload.data.balance, 5000);

  const debited = await run(
    admin.adminAdjustTreasury,
    mkReq({ params: { id: clanId }, body: { amount: 2000, direction: "out" } })
  );
  assert.equal(debited.payload.data.balance, 3000);
});

test("admin can soft-delete (moderate) a clan chat message", async () => {
  const { owner, clanId } = await makeClan("MOD");
  const chatService = require("../services/chatService");
  const msg = await chatService.sendMessage({
    senderId: owner,
    channel: "clan",
    channelId: clanId,
    body: "رسالة مخالفة",
  });

  await run(
    admin.adminModerateMessage,
    mkReq({ params: { messageId: String(msg._id) }, body: { deleted: true } })
  );

  const after = await ChatMessage.findById(msg._id).lean();
  assert.equal(after.deleted, true);

  // Deleted messages drop out of history.
  const history = await chatService.getHistory({ channel: "clan", channelId: clanId });
  assert.equal(history.some((m) => String(m._id) === String(msg._id)), false);
});

test("admin transfer of ownership swaps roles", async () => {
  const { owner, clanId } = await makeClan("ATR");
  const heir = await makeUser("Heir");
  await membership.joinClan(heir, clanId);

  await run(
    admin.adminTransferOwnership,
    mkReq({ params: { id: clanId }, body: { userId: String(heir) } })
  );

  const clan = await Clan.findById(clanId).lean();
  assert.equal(String(clan.owner), String(heir));
  assert.equal((await ClanMember.findOne({ user: heir }).lean()).role, "owner");
  assert.notEqual((await ClanMember.findOne({ user: owner }).lean()).role, "owner");
});

// ─── leaderboards ─────────────────────────────────────────────────────────────

test("global leaderboard ranks clans by rankScore", async () => {
  const a = await makeClan("LDA");
  const b = await makeClan("LDB");
  await Clan.updateOne({ _id: a.clanId }, { $set: { "stats.rankScore": 50 } });
  await Clan.updateOne({ _id: b.clanId }, { $set: { "stats.rankScore": 900 } });

  const board = await leaderboard.getLeaderboard({ scope: "global" });
  assert.equal(board.data[0].id, b.clanId, "highest rankScore first");
  assert.equal(board.data[0].rank, 1);
  assert.equal(board.data[1].id, a.clanId);
});

test("win-rate leaderboard excludes clans below the minimum games gate", async () => {
  const small = await makeClan("SML");
  const big = await makeClan("BIG");
  // Perfect record but far too few games → excluded.
  await Clan.updateOne({ _id: small.clanId }, { $set: { "stats.gamesPlayed": 2, "stats.wins": 2 } });
  await Clan.updateOne({ _id: big.clanId }, { $set: { "stats.gamesPlayed": 100, "stats.wins": 60 } });

  const board = await leaderboard.getLeaderboard({ scope: "highest_win_rate" });
  const ids = board.data.map((r) => r.id);
  assert.ok(ids.includes(big.clanId), "qualifying clan present");
  assert.equal(ids.includes(small.clanId), false, "tiny-sample clan excluded");
});

test("country leaderboard filters by country", async () => {
  const { clanId } = await makeClan("CTY");
  await Clan.updateOne({ _id: clanId }, { $set: { country: "SA" } });

  const sa = await leaderboard.getLeaderboard({ scope: "country", country: "SA" });
  assert.equal(sa.data.length, 1);
  const eg = await leaderboard.getLeaderboard({ scope: "country", country: "EG" });
  assert.equal(eg.data.length, 0);
});

// ─── badges ───────────────────────────────────────────────────────────────────

test("badge lookup returns tags for members and omits clanless users", async () => {
  const { owner, clanId } = await makeClan("BDG");
  const loner = await makeUser("Loner");

  const map = await badges.attachBadges([String(owner), String(loner)]);
  assert.equal(map[String(owner)].tag, "BDG");
  assert.equal(map[String(owner)].role, "owner");
  assert.equal(map[String(loner)], undefined, "clanless user has no badge");

  // Banned clans stop emitting badges.
  await Clan.updateOne({ _id: clanId }, { $set: { status: "banned" } });
  const afterBan = await badges.attachBadges([String(owner)]);
  assert.equal(afterBan[String(owner)], undefined, "banned clan yields no badge");
});
