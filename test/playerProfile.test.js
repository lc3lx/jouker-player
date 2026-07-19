"use strict";

/**
 * Player profile popup — public profile aggregation + admin moderation suite.
 * Covers identity/stats/coin-aggregation, per-game (extensible), VIP, agent,
 * cosmetics, viewer-relative relationship, admin flag + moderation-state,
 * hidden-profile stripping, and the ban/mute admin actions.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Player = require("../models/playerModel");
const VIPSubscription = require("../models/vipSubscriptionModel");
const AgentProfile = require("../models/agentProfileModel");
const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const profileSvc = require("../services/playerProfileService");
const friendService = require("../services/friendService");
const moderation = require("../services/adminUserModerationService");
const cosmeticsService = require("../services/cosmeticsService");
const giftService = require("../services/giftService");
const Achievement = require("../models/achievementModel");

let replSet = null;
const savedEnv = {};

async function makeUser(fields = {}) {
  const u = await User.create({
    name: fields.name || "User",
    email: `${new mongoose.Types.ObjectId()}@t.co`,
    password: "secret123",
    ...fields,
  });
  await Wallet.create({ user: u._id, balance: fields.balance || 0 });
  return u;
}

function mockReq(params = {}, body = {}, user = {}) {
  return { params, body, user, headers: {}, query: {} };
}
function mockRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const next = (e) => { if (e) throw e; };

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "player_profile_test" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("public profile: identity + lifetime stats + coin aggregation + per-game", async () => {
  const viewer = await makeUser({ name: "Viewer" });
  const target = await makeUser({ name: "Target", country: "SA", pokerHandsPlayed: 40, pokerHandsWon: 12, pokerWinStreak: 3 });
  await Player.create({ user: target._id, displayName: "Target", stats: { gamesPlayed: 10, wins: 6, bestScore: 999, totalPlayTimeSec: 3600, level: 5, experience: 1000 } });
  const tx = (type, amount, balanceAfter) => ({
    userId: target._id, type, amount,
    balanceBefore: 0, balanceAfter,
    lockedBalanceBefore: 0, lockedBalanceAfter: 0,
  });
  await WalletTransaction.create([
    tx("win", 500, 500),
    tx("game_win", 300, 800),
    tx("game_loss", 200, 600),
    tx("bet", 100, 500),
  ]);

  const p = await profileSvc.getPublicProfile(viewer._id, target._id);
  assert.equal(p.identity.name, "Target");
  assert.equal(p.identity.country, "SA");
  assert.equal(p.identity.shortId.length, 6);
  assert.ok(p.identity.memberSince);

  const g = p.stats.general;
  assert.equal(g.gamesPlayed, 10);
  assert.equal(g.wins, 6);
  assert.equal(g.losses, 4);
  assert.ok(Math.abs(g.winRate - 0.6) < 1e-9);
  assert.equal(g.totalWon, 800, "win + game_win");
  assert.equal(g.biggestWin, 500);
  assert.equal(g.totalLost, 300, "game_loss + bet");
  assert.equal(g.highestBalance, 800);

  const poker = p.perGame.find((x) => x.key === "poker");
  assert.equal(poker.stats.handsPlayed, 40);
  assert.equal(poker.stats.handsWon, 12);
  assert.equal(poker.stats.winStreak, 3);

  assert.equal(p.relationship.isFriend, false);
  assert.equal(p.relationship.requestPending, "none");
  assert.equal(p.viewerIsAdmin, false);
  assert.equal(p.moderation, undefined, "non-admin never sees moderation flags");
});

test("public profile: VIP + agent + cosmetics surfaced", async () => {
  const viewer = await makeUser({ name: "V2" });
  const target = await makeUser({ name: "Vip Agent" });
  await VIPSubscription.create({ userId: target._id, currentLevel: "gold", startDate: new Date(), expireDate: new Date(Date.now() + 30 * 864e5), status: "active" });
  await AgentProfile.create({ user: target._id, roleType: "agent", status: "approved", referralCode: "AG12CODE", deposit: { enabled: true, displayName: "Recharge King", paymentMethods: ["USDT", "Cash"], workingHours: "9-5", whatsapp: "+100" } });
  const frame = await Cosmetic.create({ type: "avatar_frame", slot: "avatar_frame", name: "F", assetKey: "vip_frame_gold", price: 0 });
  await UserCosmetics.create({ user: target._id, ownedItems: [frame._id], equippedBySlot: new Map() });
  await cosmeticsService.equipCosmetic(target._id, String(frame._id));
  profileSvc.invalidate(target._id);

  const p = await profileSvc.getPublicProfile(viewer._id, target._id);
  assert.equal(p.vip.isVip, true);
  assert.equal(p.vip.level, "gold");
  assert.equal(p.vip.name, "Gold");
  assert.equal(p.agent.isAgent, true);
  assert.equal(p.agent.displayName, "Recharge King");
  assert.deepEqual(p.agent.paymentMethods, ["USDT", "Cash"]);
  assert.equal(p.agent.whatsapp, "+100");
  assert.equal(p.cosmetics.avatarFrame, "vip_frame_gold");
});

test("relationship: outgoing request → friends reflected", async () => {
  const viewer = await makeUser({ name: "V3" });
  const target = await makeUser({ name: "T3" });
  await friendService.sendFriendRequest(viewer._id, target._id);
  let rel = await friendService.getRelationship(viewer._id, target._id);
  assert.equal(rel.requestPending, "outgoing");
  assert.equal(rel.isFriend, false);

  await friendService.acceptFriendRequest(target._id, rel.requestId);
  rel = await friendService.getRelationship(viewer._id, target._id);
  assert.equal(rel.isFriend, true);
  assert.equal(rel.requestPending, "none");
});

test("admin viewer sees moderation flags; hidden profile stripped for others", async () => {
  const admin = await makeUser({ name: "Admin", role: "admin" });
  const target = await makeUser({ name: "Hidden", preferences: { hideProfile: true } });
  await Player.create({ user: target._id, displayName: "Hidden", stats: { gamesPlayed: 5, wins: 2 } });

  // Non-admin sees a hidden profile with stats stripped.
  const stranger = await makeUser({ name: "Stranger" });
  const hiddenView = await profileSvc.getPublicProfile(stranger._id, target._id);
  assert.equal(hiddenView.hidden, true);
  assert.equal(hiddenView.stats, null);

  // Admin sees full stats + moderation state.
  const adminView = await profileSvc.getPublicProfile(admin._id, target._id);
  assert.equal(adminView.viewerIsAdmin, true);
  assert.ok(adminView.stats, "admin sees stats despite hideProfile");
  assert.ok(adminView.moderation);
  assert.equal(adminView.moderation.active, true);
  assert.equal(adminView.moderation.muted, false);
});

test("admin moderation: mute + ban flip flags and bust the cache", async () => {
  const admin = await makeUser({ name: "Admin2", role: "admin" });
  const target = await makeUser({ name: "Naughty" });

  // Warm the cache, then mute.
  await profileSvc.getPublicProfile(admin._id, target._id);
  await moderation.adminMuteUser(mockReq({ id: String(target._id) }, { reason: "spam" }, { _id: admin._id }), mockRes(), next);
  const afterMute = await profileSvc.getPublicProfile(admin._id, target._id);
  assert.equal(afterMute.moderation.muted, true, "cache invalidated → muted reflected");

  await moderation.adminBanUser(mockReq({ id: String(target._id) }, {}, { _id: admin._id }), mockRes(), next);
  const banned = await User.findById(target._id).lean();
  assert.equal(banned.active, false, "ban deactivates account");

  const afterBan = await profileSvc.getPublicProfile(admin._id, target._id);
  assert.equal(afterBan.moderation.active, false);
});

// ── enrichment: VIP expiry + benefits, achievements, inventory, inspect ───────

test("enrichment: VIP expiry/daysRemaining/benefits + achievements + inventory + inspect (one call)", async () => {
  const viewer = await makeUser({ name: "V4" });
  const target = await makeUser({ name: "Rich" });
  await VIPSubscription.create({ userId: target._id, currentLevel: "gold", startDate: new Date(), expireDate: new Date(Date.now() + 10 * 864e5), status: "active" });

  const ach = await Achievement.create({ code: "FIRST_WIN", title: "أول فوز", icon: "trophy", points: 10, category: "milestone" });
  await Player.create({ user: target._id, displayName: "Rich", stats: { gamesPlayed: 3, wins: 2 }, achievements: [ach._id] });

  const frame = await Cosmetic.create({ type: "avatar_frame", slot: "avatar_frame", name: "Owned Frame", assetKey: "own_frame", price: 100, renderType: "png" });
  const chip = await Cosmetic.create({ type: "chip_set", slot: "chip_set", name: "Gold Chips", assetKey: "gold_chips", price: 200 });
  await UserCosmetics.create({ user: target._id, ownedItems: [frame._id, chip._id], equippedBySlot: new Map() });
  await cosmeticsService.equipCosmetic(target._id, String(frame._id));
  profileSvc.invalidate(target._id);

  const p = await profileSvc.getPublicProfile(viewer._id, target._id);
  // VIP enrichment
  assert.ok(p.vip.expireDate, "vip expiry present");
  assert.ok(p.vip.daysRemaining >= 9 && p.vip.daysRemaining <= 10, "days remaining computed");
  assert.ok(p.vip.benefits && p.vip.benefits.dailyChips > 0, "benefits preview present");
  // Achievements
  assert.equal(p.achievements.length, 1);
  assert.equal(p.achievements[0].code, "FIRST_WIN");
  // Inventory (grouped) + counts
  assert.ok(p.cosmetics.inventory.avatar_frame?.some((c) => c.assetKey === "own_frame"));
  assert.ok(p.cosmetics.inventory.chip_set?.some((c) => c.assetKey === "gold_chips"));
  assert.equal(p.cosmetics.inventoryCount, 2);
  // Inspect (equipped detailed with render info)
  assert.equal(p.cosmetics.equipped.avatar_frame.assetKey, "own_frame");
  assert.equal(p.cosmetics.equipped.avatar_frame.renderType, "png");
});

test("fresh=true bypasses the snapshot cache", async () => {
  const viewer = await makeUser({ name: "V5" });
  const target = await makeUser({ name: "Fresh", country: "EG" });
  await profileSvc.getPublicProfile(viewer._id, target._id); // warm
  await User.updateOne({ _id: target._id }, { $set: { country: "US" } });
  const cached = await profileSvc.getPublicProfile(viewer._id, target._id);
  assert.equal(cached.identity.country, "EG", "cache still serves old value");
  const fresh = await profileSvc.getPublicProfile(viewer._id, target._id, { fresh: true });
  assert.equal(fresh.identity.country, "US", "fresh bypasses cache");
});

// ── gifts (coins + cosmetic + guards) ────────────────────────────────────────

const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;

test("gift coins: debits sender, credits receiver atomically", async () => {
  const sender = await makeUser({ name: "Giver", balance: 5000 });
  const target = await makeUser({ name: "Getter", balance: 0 });
  const r = await giftService.sendGift({ senderId: sender._id, targetId: target._id, type: "coins", amount: 1500 });
  assert.equal(r.ok, true);
  assert.equal(await balanceOf(sender._id), 3500);
  assert.equal(await balanceOf(target._id), 1500);
});

test("gift cosmetic: charges sender, adds to receiver inventory", async () => {
  const sender = await makeUser({ name: "Buyer", balance: 5000 });
  const target = await makeUser({ name: "Recv", balance: 0 });
  const item = await Cosmetic.create({ type: "avatar_frame", slot: "avatar_frame", name: "Gift Frame", assetKey: "gift_frame", price: 800, status: "published" });
  const r = await giftService.sendGift({ senderId: sender._id, targetId: target._id, type: "cosmetic", cosmeticId: String(item._id) });
  assert.equal(r.cost, 800);
  assert.equal(await balanceOf(sender._id), 4200);
  const row = await UserCosmetics.findOne({ user: target._id }).lean();
  assert.ok(row.ownedItems.some((id) => String(id) === String(item._id)), "cosmetic granted to receiver");
});

test("gift guards: self / blocked / insufficient balance", async () => {
  const a = await makeUser({ name: "GA", balance: 100 });
  const b = await makeUser({ name: "GB", balance: 0 });
  await assert.rejects(() => giftService.sendGift({ senderId: a._id, targetId: a._id, type: "coins", amount: 100 }), /yourself/);
  await friendService.blockUser(b._id, a._id);
  await assert.rejects(() => giftService.sendGift({ senderId: a._id, targetId: b._id, type: "coins", amount: 100 }), /blocked/);
  const c = await makeUser({ name: "GC", balance: 50 });
  const d = await makeUser({ name: "GD", balance: 0 });
  await assert.rejects(() => giftService.sendGift({ senderId: c._id, targetId: d._id, type: "coins", amount: 5000 }), /Insufficient/);
});
