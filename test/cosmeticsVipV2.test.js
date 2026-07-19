"use strict";

/**
 * Cosmetics + VIP live-service platform regression suite.
 *
 * Covers the data-model evolution (de-enum + new fields + status mirror), the
 * flexible equip-slot map with legacy mirror, the DB-backed VIP level registry
 * (sync compat layer) + rewards projection, idempotent migrations, live
 * broadcasts, and backward compatibility with the existing store/equip paths.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const VipLevel = require("../models/vipLevelModel");
const VipReward = require("../models/vipRewardModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const cosmeticsService = require("../services/cosmeticsService");
const vipConfig = require("../config/vipConfig");
const vipLevelRegistry = require("../services/vipLevelRegistry");
const vipRewardService = require("../services/vipRewardService");
const economyBroadcast = require("../services/economyBroadcast");
const cosmeticsLive = require("../services/cosmeticsLive");
const vipLive = require("../services/vipLive");
const migrate = require("../scripts/migrateCosmeticsVipV2");

let replSet = null;
const savedEnv = {};
const events = [];

function installFakeNamespace() {
  economyBroadcast._resetForTests();
  economyBroadcast.registerNamespace({ emit: (event, payload) => events.push({ event, payload }) });
}

async function ownRow(userId, cosmeticId) {
  return UserCosmetics.create({ user: userId, ownedItems: [cosmeticId], equippedBySlot: new Map() });
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
  await mongoose.connect(replSet.getUri(), { dbName: "cosmetics_vip_v2" });
  installFakeNamespace();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  economyBroadcast._resetForTests();
  vipLevelRegistry._resetForTests();
  vipRewardService._resetForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── data model: de-enum + defaults + status mirror ───────────────────────────

test("cosmetic model: free-string type/rarity + pre-save defaults", async () => {
  const c = await Cosmetic.create({ type: "chat_badge", name: "Sparkle", assetKey: "badge_sparkle", price: 500, rarity: "mythic" });
  assert.equal(c.type, "chat_badge");
  assert.equal(c.rarity, "mythic", "rarity is a free string now");
  assert.equal(c.renderType, "png", "renderType defaults");
  assert.equal(c.currencyId, "coins");
  assert.equal(c.slot, "chat_badge", "slot defaulted from type");
  assert.equal(c.category, "chat_badge");
  assert.deepEqual(c.games, ["all"]);
  assert.equal(c.status, "published");
  assert.equal(c.isActive, true, "isActive mirrors published");
});

test("cosmetic model: status↔isActive mirror both directions", async () => {
  const draft = await Cosmetic.create({ type: "avatar_frame", name: "D", assetKey: "frame_d", status: "draft" });
  assert.equal(draft.isActive, false, "draft is not active");
  const inactive = await Cosmetic.create({ type: "avatar_frame", name: "I", assetKey: "frame_i", isActive: false });
  assert.equal(inactive.status, "disabled", "isActive:false → disabled");
});

// ── flexible equip slots ─────────────────────────────────────────────────────

test("equip: new slot kind works with no code change + legacy mirror for old slots", async () => {
  const userId = new mongoose.Types.ObjectId();
  const badge = await Cosmetic.create({ type: "chat_badge", slot: "chat_badge", name: "B", assetKey: "cb1", price: 0 });
  const frame = await Cosmetic.create({ type: "avatar_frame", slot: "avatar_frame", name: "F", assetKey: "af1", price: 0 });
  await ownRow(userId, badge._id);
  await UserCosmetics.updateOne({ user: userId }, { $push: { ownedItems: frame._id } });

  await cosmeticsService.equipCosmetic(userId, String(badge._id));
  const me1 = await cosmeticsService.equipCosmetic(userId, String(frame._id));

  assert.equal(me1.equipped.bySlot.chat_badge, "cb1", "new slot equipped");
  assert.equal(me1.equipped.bySlot.avatar_frame, "af1");
  assert.equal(me1.equipped.avatarFrame, "af1", "legacy mirror populated");
  assert.equal(me1.equipped.skin, "af1", "skin alias mirrors avatar_frame");

  // Legacy DB mirror field written for backward-compatible reads.
  const row = await UserCosmetics.findOne({ user: userId }).lean();
  assert.ok(row.equipped.avatarFrame, "legacy equipped.avatarFrame set");
  assert.equal(row.equippedBySlot.chat_badge?.toString(), String(badge._id));
});

test("resolveEquippedPayloadForUsers: bulk read includes bySlot + legacy keys", async () => {
  const userId = new mongoose.Types.ObjectId();
  const frame = await Cosmetic.create({ type: "avatar_frame", slot: "avatar_frame", name: "F2", assetKey: "af2", price: 0 });
  await ownRow(userId, frame._id);
  await cosmeticsService.equipCosmetic(userId, String(frame._id));
  const map = await cosmeticsService.resolveEquippedPayloadForUsers([userId]);
  const p = map.get(String(userId));
  assert.equal(p.avatarFrame, "af2");
  assert.equal(p.bySlot.avatar_frame, "af2");
});

// ── VIP level registry (DB-backed sync compat) ───────────────────────────────

test("VIP registry: sync defaults work; new DB level visible after refresh", async () => {
  // Defaults available synchronously (seeded) before any custom level.
  assert.equal(vipConfig.normalizeVipLevel("gold"), "gold");
  assert.equal(vipConfig.vipLevelRank("platinum"), 4);

  await VipLevel.create({
    key: "diamond", name: "Diamond", priority: 5, priceUsd: 79.99, priceCents: 7999,
    benefits: { cashbackPercent: 50, dailyChips: 999000, quiz: true, priorityQueue: true, queueBoostMs: 1000, weeklyCashbackCapChips: 99 },
  });
  await vipLevelRegistry.refresh();

  assert.equal(vipConfig.normalizeVipLevel("DIAMOND"), "diamond", "new level normalizes");
  assert.equal(vipConfig.vipLevelRank("diamond"), 5, "rank from DB priority");
  assert.equal(vipConfig.vipLevelConfig("diamond").dailyChips, 999000);
  const levels = vipConfig.getVipLevels();
  assert.ok(levels.includes("diamond"));
  assert.equal(levels[levels.length - 1], "diamond", "ordered last by rank");
  assert.equal(vipConfig.publicBenefits("diamond").highestPriority, true, "highest rank now");
  assert.equal(vipConfig.publicBenefits("platinum").highestPriority, false);
});

// ── VIP rewards (DB projection + fallback) ───────────────────────────────────

test("VIP rewards: legacy fallback before seed, DB projection after", async () => {
  vipRewardService._resetForTests();
  // Fallback to legacy mapping (byte-identical to old config).
  assert.equal(vipRewardService.vipCosmeticsForLevel("gold").tableTheme, "vip_gold");
  assert.equal(vipRewardService.vipCosmeticsForLevel("gold").tableAsset, "vip/gold/taple_vip_golde.png");

  await migrate.seedVipRewards();
  await vipRewardService.refresh();
  const gold = vipRewardService.vipCosmeticsForLevel("gold");
  assert.equal(gold.tableTheme, "vip_gold", "DB reward projects same tableTheme");
  assert.equal(gold.cardSkin, "vip_gold");
  assert.ok(Array.isArray(gold.cardAssets) && gold.cardAssets.length === 2, "card assets preserved");
  assert.ok(gold.grants.length >= 2, "generic grants list present");
});

// ── migrations (idempotent) ──────────────────────────────────────────────────

test("migration: cosmetics v2 + equippedBySlot are idempotent", async () => {
  // Insert a pre-v2 shaped doc bypassing pre-save defaults.
  await Cosmetic.collection.insertOne({ type: "table_theme", name: "Legacy", assetKey: "legacy_tt", price: 100, isActive: true });
  const r1 = await migrate.migrateCosmeticsV2();
  assert.ok(r1.updated >= 1, "backfilled the legacy doc");
  const doc = await Cosmetic.findOne({ assetKey: "legacy_tt" }).lean();
  assert.equal(doc.slot, "table_theme");
  assert.equal(doc.renderType, "png");
  assert.equal(doc.status, "published");

  const r2 = await migrate.migrateCosmeticsV2();
  assert.equal(r2.updated, 0, "re-run changes nothing");

  // Legacy equipped → equippedBySlot backfill.
  const uid = new mongoose.Types.ObjectId();
  const frame = await Cosmetic.create({ type: "avatar_frame", name: "MF", assetKey: "mf1", price: 0 });
  await UserCosmetics.collection.insertOne({ user: uid, ownedItems: [frame._id], equipped: { avatarFrame: frame._id, tableTheme: null, cardSkin: null } });
  const e1 = await migrate.migrateEquippedBySlot();
  assert.ok(e1.updated >= 1);
  const row = await UserCosmetics.findOne({ user: uid }).lean();
  assert.equal(row.equippedBySlot.avatar_frame?.toString(), String(frame._id));
  const e2 = await migrate.migrateEquippedBySlot();
  assert.equal(e2.updated, 0, "idempotent");
});

test("migration: seedVipLevels seeds the 4 defaults idempotently", async () => {
  await VipLevel.deleteMany({ key: { $in: ["bronze", "silver"] } });
  const r = await migrate.seedVipLevels();
  assert.ok(r.created >= 2, "reseeded missing defaults");
  const again = await migrate.seedVipLevels();
  assert.equal(again.created, 0, "idempotent");
});

// ── live broadcasts ──────────────────────────────────────────────────────────

test("live: cosmetics + vip edits broadcast to clients", async () => {
  events.length = 0;
  cosmeticsLive.refresh({ reason: "test" });
  assert.ok(events.some((e) => e.event === "cosmetics_updated"), "cosmetics_updated emitted");
  events.length = 0;
  await vipLive.refresh({ reason: "test", levels: true });
  assert.ok(events.some((e) => e.event === "vip_updated"), "vip_updated emitted");
});

// ── backward compatibility ───────────────────────────────────────────────────

test("backward-compat: store hides VIP-granted cosmetics; buy/equip unaffected", async () => {
  // VIP cosmetics (vipLevelRequired set) never appear in the store catalog.
  const catalog = await cosmeticsService.listCatalog();
  assert.equal(catalog.some((c) => c.assetKey === "vip_gold"), false, "VIP theme hidden from store");

  // A normal store cosmetic remains visible and equippable.
  const sticker = await Cosmetic.create({ type: "avatar_frame", name: "Store Frame", assetKey: "store_frame_1", price: 0 });
  const fresh = await cosmeticsService.listCatalog();
  assert.ok(fresh.some((c) => c.assetKey === "store_frame_1"), "store cosmetic visible");

  const uid = new mongoose.Types.ObjectId();
  await ownRow(uid, sticker._id);
  const me = await cosmeticsService.equipCosmetic(uid, String(sticker._id));
  assert.equal(me.equipped.avatarFrame, "store_frame_1");
});
