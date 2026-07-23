"use strict";

/**
 * Clan membership, invitations and join-requests.
 * Covers: public instant join, one-clan enforcement, leave rules, kick (perm+rank),
 * role changes (no self-elevation), ownership transfer, invite→accept, request→accept.
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
const membership = require("../services/clanMembershipService");
const invitations = require("../services/clanInvitationService");
const requests = require("../services/clanRequestService");

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  if (balance > 0) await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}

async function makeClan(ownerName, tag, joinType = "public") {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser(ownerName, settings.creationCost + 1);
  const clan = await clanService.createClan(owner, { name: ownerName + " Clan", tag, joinType });
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_membership_test" });
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
    mongoose.connection.collection("claninvitations").deleteMany({}).catch(() => {}),
    mongoose.connection.collection("clanjoinrequests").deleteMany({}).catch(() => {}),
  ]);
  clanService.invalidateSettingsCache();
});

test("public join is instant and increments memberCount; denorm set", async () => {
  const { clanId } = await makeClan("Owner", "PUB", "public");
  const joiner = await makeUser("Joiner");
  const res = await membership.joinClan(joiner, clanId);
  assert.equal(res.status, "joined");
  const clan = await Clan.findById(clanId).lean();
  assert.equal(clan.memberCount, 2);
  const u = await User.findById(joiner).lean();
  assert.equal(u.clan.tag, "PUB");
  assert.equal(u.clan.role, "member");
});

test("a player cannot join a second clan", async () => {
  const a = await makeClan("A", "AAA", "public");
  const b = await makeClan("B", "BBB", "public");
  const joiner = await makeUser("Joiner");
  await membership.joinClan(joiner, a.clanId);
  await assert.rejects(() => membership.joinClan(joiner, b.clanId), (e) => e.statusCode === 409);
});

test("owner cannot leave; non-owner can", async () => {
  const { owner, clanId } = await makeClan("Owner", "LEV", "public");
  const m = await makeUser("Member");
  await membership.joinClan(m, clanId);
  await assert.rejects(() => membership.leaveClan(owner), (e) => e.statusCode === 400);
  const left = await membership.leaveClan(m);
  assert.equal(left.status, "left");
  const clan = await Clan.findById(clanId).lean();
  assert.equal(clan.memberCount, 1);
  assert.equal(await ClanMember.countDocuments({ user: m }), 0);
});

test("kick requires permission and higher rank", async () => {
  const { owner, clanId } = await makeClan("Owner", "KCK", "public");
  const officer = await makeUser("Officer");
  const victim = await makeUser("Victim");
  await membership.joinClan(officer, clanId);
  await membership.joinClan(victim, clanId);
  await membership.setMemberRole(owner, clanId, officer, "officer");

  // Officer lacks the kick permission by default.
  await assert.rejects(() => membership.kickMember(officer, clanId, victim), (e) => e.statusCode === 403);
  // Owner can kick.
  const res = await membership.kickMember(owner, clanId, victim);
  assert.equal(res.status, "kicked");
  assert.equal(await ClanMember.countDocuments({ user: victim }), 0);
});

test("cannot assign a role at or above your own", async () => {
  const { owner, clanId } = await makeClan("Owner", "ROL", "public");
  const coleader = await makeUser("Co");
  const target = await makeUser("T");
  await membership.joinClan(coleader, clanId);
  await membership.joinClan(target, clanId);
  await membership.setMemberRole(owner, clanId, coleader, "coleader");
  // Coleader trying to make target a leader (>= own rank) → blocked.
  await assert.rejects(
    () => membership.setMemberRole(coleader, clanId, target, "leader"),
    (e) => e.statusCode === 403
  );
});

test("ownership transfer swaps roles and updates clan.owner", async () => {
  const { owner, clanId } = await makeClan("Owner", "TRN", "public");
  const heir = await makeUser("Heir");
  await membership.joinClan(heir, clanId);
  await membership.transferOwnership(owner, clanId, heir);
  const clan = await Clan.findById(clanId).lean();
  assert.equal(String(clan.owner), String(heir));
  assert.equal((await ClanMember.findOne({ user: heir }).lean()).role, "owner");
  assert.equal((await ClanMember.findOne({ user: owner }).lean()).role, "leader");
});

test("invite → accept seats the invited user", async () => {
  const { owner, clanId } = await makeClan("Owner", "INV", "invite");
  const invitee = await makeUser("Invitee");
  const inv = await invitations.sendInvitation(owner, clanId, invitee);
  const res = await invitations.acceptInvitation(invitee, inv.id);
  assert.equal(res.status, "joined");
  assert.equal(await ClanMember.countDocuments({ clan: clanId, user: invitee }), 1);
});

test("request-type join queues a request that a manager accepts", async () => {
  const { owner, clanId } = await makeClan("Owner", "REQ", "request");
  const applicant = await makeUser("Applicant");
  const j = await membership.joinClan(applicant, clanId);
  assert.equal(j.status, "requested");
  const pending = await requests.listRequests(owner, clanId);
  assert.equal(pending.length, 1);
  await requests.acceptRequest(owner, pending[0].id);
  assert.equal(await ClanMember.countDocuments({ clan: clanId, user: applicant }), 1);
});
