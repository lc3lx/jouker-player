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

test("rectangular table image survives cache and reaches only its selected games", async () => {
  const uid = new mongoose.Types.ObjectId();
  const row = await Cosmetic.create({ type: "table_theme", name: "Emerald test",
    assetKey: "rect_emerald_test", price: 0, games: ["trix", "tarneeb41"],
    previewImage: "emerald_test.png" });
  await ownRow(uid, row._id);
  await cosmeticsService.equipCosmetic(uid, String(row._id));
  const resolver = require("../services/playerPublicCosmeticsService");
  const seats = [{ userId: String(uid), seatIndex: 0 }];
  for (const game of ["trix", "tarneeb41", "trix"]) {
    const result = await resolver.resolveCardGameCosmeticsForSeats(seats, game);
    assert.equal(result.activeTableTheme, "rect_emerald_test");
    assert.equal(result.activeTableAsset, "/uploads/cosmetics/emerald_test.png");
  }
  const poker = await resolver.resolvePublicCosmeticsForPokerSeats(seats);
  assert.equal(poker.activeTableTheme, null);
  assert.equal(poker.activeTableAsset, null);
});

test("new eastern table is added to existing catalogs without resetting an admin price", async () => {
  await Cosmetic.create({ type: "table_theme", name: "Existing", assetKey: "existing_before_east", price: 10 });
  let catalog = await cosmeticsService.listCatalog();
  const table = catalog.find((row) => row.assetKey === "arabesque_palace");
  assert.equal(table.price, 30_000_000);
  await Cosmetic.updateOne({ _id: table.id }, { $set: { price: 31_000_000 } });
  catalog = await cosmeticsService.listCatalog();
  assert.equal(catalog.find((row) => row.assetKey === "arabesque_palace").price, 31_000_000);
  assert.equal(await Cosmetic.countDocuments({ assetKey: "arabesque_palace" }), 1);
});

test("Dubai and Damascus are added once with requested prices and retain admin changes", async () => {
  const catalog = await cosmeticsService.listCatalog();
  for (const [key, price] of [["dubai_nights", 30_000_000], ["damascus_mosaic", 20_000_000]]) {
    const row = catalog.find((item) => item.assetKey === key);
    assert.equal(row.price, price);
    assert.deepEqual(row.games, ["trix", "tarneeb41"]);
    assert.equal(row.previewImageUrl, `/assets/tables/${key}.png`);
    await Cosmetic.updateOne({ _id: row.id }, { $set: { price: price + 1 } });
    const refreshed = await cosmeticsService.listCatalog();
    assert.equal(refreshed.find((item) => item.assetKey === key).price, price + 1);
    assert.equal(await Cosmetic.countDocuments({ assetKey: key }), 1);
  }
});

test("admin table upload, price update and equipped image reach the table without a client asset key", async () => {
  const admin = require("../services/adminCosmeticsService");
  const sharp = require("sharp");
  const fs = require("fs/promises");
  const path = require("path");
  async function call(handler, req) {
    let result, error;
    const res = { status() { return this; }, json(value) { result = value; } };
    await handler(req, res, (err) => { error = err; });
    if (error) throw error;
    return result;
  }
  const req = { body: { type: "table_theme", name: "Custom moon table", assetKey: "custom_moon_123",
    price: "750", status: "published", games: '["poker"]' }, params: {}, headers: {},
    file: { buffer: await sharp({ create: { width: 1600, height: 640, channels: 4,
      background: { r: 80, g: 100, b: 140, alpha: 0.5 } } }).png().toBuffer() } };
  await call(admin.resizeCosmeticPreview, req);
  const file = path.resolve("uploads", "cosmetics", req.body.previewImage);
  const generatedFiles = [file];
  try {
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 640);
    assert.equal(metadata.hasAlpha, true);
    assert.equal(metadata.format, "png");
    const created = (await call(admin.adminCreateCosmetic, req)).data;
    const uid = new mongoose.Types.ObjectId();
    await ownRow(uid, created.id);
    await cosmeticsService.equipCosmetic(uid, created.id);
    const payload = (await cosmeticsService.resolveEquippedPayloadForUsers([uid])).get(String(uid));
    assert.equal(payload.tableAsset, `/uploads/cosmetics/${req.body.previewImage}`);
    const active = require("../services/playerPublicCosmeticsService").resolveActiveTableCosmetics([
      { seatIndex: 0, equippedTableTheme: payload.tableTheme, equippedTableAsset: payload.tableAsset },
    ]);
    assert.equal(active.activeTableAsset, payload.tableAsset);
    const updateReq = { params: { id: created.id }, headers: {}, body: { price: "1250" }, file: { buffer: req.file.buffer } };
    await call(admin.resizeCosmeticPreview, updateReq);
    generatedFiles.push(path.resolve("uploads", "cosmetics", updateReq.body.previewImage));
    const updated = await call(admin.adminUpdateCosmetic, updateReq);
    assert.equal(updated.data.basePrice, 1250);
    assert.equal((await cosmeticsService.listCatalog()).find((x) => x.id === created.id).price, 1250);
    await assert.rejects(() => call(admin.adminUpdateCosmetic, { params: { id: created.id }, headers: {}, body: { price: "invalid" } }), /Price must/);
    assert.equal((await Cosmetic.findById(created.id)).price, 1250);
    const changed = (await cosmeticsService.resolveEquippedPayloadForUsers([uid])).get(String(uid));
    assert.equal(changed.tableAsset, `/uploads/cosmetics/${updateReq.body.previewImage}`);
    assert.notEqual(changed.tableAsset, payload.tableAsset, "replacing art invalidates equipped-user cache");
  } finally {
    await Promise.all(generatedFiles.map((file) => fs.unlink(file)));
  }
});

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

  const rowOn = await UserCosmetics.findOne({ user: userId }).lean();
  assert.ok(rowOn.equipped.avatarFrame, "legacy equipped.avatarFrame set");

  const meOff = await cosmeticsService.unequipCosmetic(userId, "avatar_frame");
  assert.equal(meOff.equipped.bySlot.avatar_frame, undefined);
  assert.equal(meOff.equipped.avatarFrame, null);
  assert.equal(meOff.equipped.skin, null);
  assert.equal(meOff.equipped.bySlot.chat_badge, "cb1", "other slots stay equipped");

  const row = await UserCosmetics.findOne({ user: userId }).lean();
  assert.equal(row.equippedBySlot.chat_badge?.toString(), String(badge._id));
  assert.ok(!row.equipped.avatarFrame, "legacy avatarFrame cleared on unequip");
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
