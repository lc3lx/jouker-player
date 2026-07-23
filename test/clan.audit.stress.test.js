"use strict";

/**
 * CLAN PRODUCTION AUDIT (part 3) — adversarial races and large-scale chaos.
 *
 *   • per-user donation daily cap under concurrent donations
 *   • unregister racing tournament start (refunded AND still in the bracket?)
 *   • concurrent achievement evaluation (double reward?)
 *   • concurrent join-request spam
 *   • full chaos: hundreds of players, mixed operations, global conservation
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
const ClanTournament = require("../models/clanTournamentModel");
const ClanTournamentMatch = require("../models/clanTournamentMatchModel");
const ClanTreasuryTransaction = require("../models/clanTreasuryTransactionModel");
const ClanJoinRequest = require("../models/clanJoinRequestModel");
const ClanAchievement = require("../models/clanAchievementModel");
const ClanAchievementDef = require("../models/clanAchievementDefModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const clanService = require("../services/clanService");
const membership = require("../services/clanMembershipService");
const treasury = require("../services/clanTreasuryService");
const engine = require("../services/clanTournamentEngineService");
const achievements = require("../services/clanAchievementService");

let replSet = null;
const savedEnv = {};

async function makeUser(name, balance = 0) {
  const userId = new mongoose.Types.ObjectId();
  await User.create({ _id: userId, name, email: `${userId}@test.io`, password: "secret123" });
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;
async function totalWalletCoins() {
  const rows = await Wallet.aggregate([{ $group: { _id: null, t: { $sum: "$balance" } } }]);
  return rows[0]?.t || 0;
}
async function totalTreasury() {
  const rows = await Clan.aggregate([{ $group: { _id: null, t: { $sum: "$treasury.balance" } } }]);
  return rows[0]?.t || 0;
}
async function liveEscrow() {
  const rows = await ClanTournament.aggregate([
    { $match: { lifecycle: { $nin: ["cancelled", "finished"] } } },
    { $group: { _id: null, t: { $sum: "$escrowHeld" } } },
  ]);
  return rows[0]?.t || 0;
}
async function makeClan(tag, ownerBalance = 0) {
  const settings = await ClanSettings.getDefaults();
  const owner = await makeUser("Owner", settings.creationCost + ownerBalance);
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
  await mongoose.connect(replSet.getUri(), { dbName: "clan_audit3_test" });
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
    Clan.deleteMany({}), ClanMember.deleteMany({}), Wallet.deleteMany({}), User.deleteMany({}),
    ClanSettings.deleteMany({}), ClanTournament.deleteMany({}), ClanTournamentMatch.deleteMany({}),
    ClanTreasuryTransaction.deleteMany({}), ClanJoinRequest.deleteMany({}),
    ClanAchievement.deleteMany({}), ClanAchievementDef.deleteMany({}),
  ]);
  clanService.invalidateSettingsCache();
});

// ══ DONATION DAILY CAP ════════════════════════════════════════════════════════

test("AUDIT: concurrent donations cannot exceed the per-user daily cap", async () => {
  const settings = await ClanSettings.getDefaults();
  settings.donationDailyLimit = 50_000;
  settings.minDonation = 1_000;
  await settings.save();
  clanService.invalidateSettingsCache();

  const { clanId } = await makeClan("CAP");
  const donor = await makeUser("Whale", 10_000_000);
  await membership.joinClan(donor, clanId);

  // 20 concurrent 10k donations against a 50k daily cap.
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () => treasury.donate(donor, clanId, 10_000))
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;

  const donatedLedger = await ClanTreasuryTransaction.aggregate([
    { $match: { clan: new mongoose.Types.ObjectId(clanId), type: "donation" } },
    { $group: { _id: null, t: { $sum: "$amount" } } },
  ]);
  const totalDonated = donatedLedger[0]?.t || 0;

  assert.ok(
    totalDonated <= settings.donationDailyLimit,
    `daily cap respected (donated ${totalDonated}, cap ${settings.donationDailyLimit}, ${ok} succeeded)`
  );
  // Whatever got through must still reconcile exactly.
  assert.equal(await treasury.getTreasury(clanId).then((t) => t.balance), totalDonated);
});

// ══ UNREGISTER RACING START ═══════════════════════════════════════════════════

test("AUDIT: unregister racing tournament start cannot refund a still-seated player", async () => {
  const FEE = 100_000;
  const { clanId, owner } = await makeClan("RCE", 2_000_000);
  const players = [owner];
  for (let i = 0; i < 5; i++) {
    const u = await makeUser(`Z${i}`, 2_000_000);
    await membership.joinClan(u, clanId);
    players.push(u);
  }

  const t = await engine.createTournament(owner, clanId, {
    game: "poker", type: "paid", entryFee: FEE, maxPlayers: 8, minPlayers: 2,
  });
  for (const p of players) await engine.register(p, t.id);

  const quitter = players[3];
  const balBefore = await balanceOf(quitter);

  // Race: the player pulls out at the exact moment the tournament starts.
  await Promise.allSettled([
    engine.unregister(quitter, t.id),
    engine.startTournament(t.id),
  ]);

  const doc = await ClanTournament.findById(t.id).lean();
  const stillSeated = doc.participants.some((p) => String(p.user) === String(quitter));
  const balAfter = await balanceOf(quitter);
  const refunded = balAfter > balBefore;

  // The invariant: refunded XOR still in the tournament — never both.
  assert.ok(
    !(refunded && stillSeated),
    `player must not be refunded while still seated (refunded=${refunded}, seated=${stillSeated})`
  );

  // Escrow must equal the fees of exactly the seated participants.
  assert.equal(
    doc.escrowHeld,
    doc.participants.length * FEE,
    "escrow matches the seated roster exactly"
  );
});

// ══ ACHIEVEMENTS ══════════════════════════════════════════════════════════════

test("AUDIT: concurrent achievement evaluation awards and pays only once", async () => {
  const { clanId } = await makeClan("ACH");
  await ClanAchievementDef.create({
    key: "audit_first_win",
    title: "First Win",
    criteria: { metric: "wins", op: "gte", threshold: 1 },
    rewardCoins: 25_000,
    rewardXp: 10,
    active: true,
  });
  await Clan.updateOne({ _id: clanId }, { $set: { "stats.wins": 5 } });

  await Promise.allSettled(Array.from({ length: 10 }, () => achievements.evaluateClan(clanId)));

  const awarded = await ClanAchievement.countDocuments({ clan: clanId, defKey: "audit_first_win" });
  assert.equal(awarded, 1, `achievement awarded exactly once (got ${awarded})`);

  const clan = await Clan.findById(clanId).lean();
  assert.equal(clan.treasury.balance, 25_000, "reward credited exactly once");
  assert.equal(clan.xp, 10, "xp granted exactly once");

  // Treasury still reconciles with its ledger.
  const led = await ClanTreasuryTransaction.aggregate([
    { $match: { clan: new mongoose.Types.ObjectId(clanId) } },
    { $group: { _id: null, t: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amount", { $multiply: ["$amount", -1] }] } } } },
  ]);
  assert.equal(led[0]?.t || 0, clan.treasury.balance, "treasury reconciles after concurrent awards");
});

// ══ JOIN REQUEST SPAM ═════════════════════════════════════════════════════════

test("AUDIT: concurrent join requests create only one pending row", async () => {
  const { clanId } = await makeClan("REQ");
  await Clan.updateOne({ _id: clanId }, { $set: { joinType: "request" } });
  const applicant = await makeUser("Spammer");

  await Promise.allSettled(
    Array.from({ length: 15 }, () => membership.joinClan(applicant, clanId))
  );

  const pending = await ClanJoinRequest.countDocuments({
    clan: clanId,
    user: applicant,
    status: "pending",
  });
  assert.equal(pending, 1, `exactly one pending request (got ${pending})`);
});

// ══ FULL CHAOS ════════════════════════════════════════════════════════════════

test("AUDIT CHAOS: 300 players, mixed concurrent operations, nothing leaks", async () => {
  const settings = await ClanSettings.getDefaults();
  settings.donationDailyLimit = 100_000_000;
  await settings.save();
  clanService.invalidateSettingsCache();

  const FEE = 50_000;
  const { clanId, owner } = await makeClan("CHS", 10_000_000);
  await Clan.updateOne({ _id: clanId }, { $set: { maxMembers: 400 } });

  const players = [];
  for (let i = 0; i < 300; i++) players.push(await makeUser(`Q${i}`, 1_000_000));

  const startWallets = await totalWalletCoins();

  // Wave 1 — everyone piles in at once.
  await Promise.allSettled(players.map((p) => membership.joinClan(p, clanId)));
  const members = await ClanMember.find({ clan: clanId }).select("user").lean();
  const memberIds = members.map((m) => String(m.user)).filter((u) => u !== String(owner));

  // Wave 2 — tournament registration, donations, leaves and a cancel all at once.
  const t = await engine.createTournament(owner, clanId, {
    game: "poker", type: "paid", entryFee: FEE, maxPlayers: 16, minPlayers: 2,
  });

  const registrants = memberIds.slice(0, 80);
  const donors = memberIds.slice(80, 160);
  const leavers = memberIds.slice(160, 200);

  await Promise.allSettled([
    ...registrants.map((p) => engine.register(p, t.id)),
    ...donors.map((p) => treasury.donate(p, clanId, 10_000)),
    ...leavers.map((p) => membership.leaveClan(p)),
  ]);

  // Wave 3 — start + concurrent cancels + concurrent unregisters (chaos).
  await Promise.allSettled([
    engine.startTournament(t.id),
    ...registrants.slice(0, 10).map((p) => engine.unregister(p, t.id)),
    engine.cancelTournament(owner, t.id, "chaos"),
    engine.cancelTournament(owner, t.id, "chaos"),
  ]);

  // ── invariants ──────────────────────────────────────────────────────────────
  const clan = await Clan.findById(clanId).lean();
  const realMembers = await ClanMember.countDocuments({ clan: clanId });
  assert.equal(clan.memberCount, realMembers, "memberCount consistent after chaos");
  assert.ok(realMembers <= clan.maxMembers, "member cap never exceeded");

  // No player belongs to two clans.
  const dupes = await ClanMember.aggregate([
    { $group: { _id: "$user", n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  assert.equal(dupes.length, 0, "no duplicate memberships");

  // Exactly one owner.
  const owners = await ClanMember.countDocuments({ clan: clanId, role: "owner" });
  assert.equal(owners, 1, "exactly one owner survives the chaos");

  // Treasury reconciles with its own ledger.
  const led = await ClanTreasuryTransaction.aggregate([
    { $match: { clan: new mongoose.Types.ObjectId(clanId) } },
    { $group: { _id: null, t: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amount", { $multiply: ["$amount", -1] }] } } } },
  ]);
  assert.equal(led[0]?.t || 0, clan.treasury.balance, "treasury reconciles under chaos");
  assert.ok(clan.treasury.balance >= 0, "treasury never negative");

  // GLOBAL CONSERVATION: every coin is either in a wallet, a treasury, or live escrow.
  const endWallets = await totalWalletCoins();
  const endTreasury = await totalTreasury();
  const endEscrow = await liveEscrow();
  assert.equal(
    endWallets + endTreasury + endEscrow,
    startWallets,
    "no coins created or destroyed across the entire chaos run"
  );

  // A cancelled tournament must hold no escrow and have refunded everyone.
  const doc = await ClanTournament.findById(t.id).lean();
  if (doc.lifecycle === "cancelled") {
    assert.equal(doc.escrowHeld, 0, "cancelled tournament holds no escrow");
  }
});
