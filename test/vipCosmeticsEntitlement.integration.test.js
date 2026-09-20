"use strict";

/**
 * A subscriber's VIP cosmetics, end to end against a real database.
 *
 * Reported as: "من وين حط سكن الـVIP ما عم لاقي عندي بالسكنات وما عم لاقي
 * الطاولة تبع الـVIP والورق، لازم اقدر شغلون وطفيون وغيرون اثناء الدق."
 *
 * Every part of that was true at once. VIP art was applied at render time and
 * never owned, so there was nothing in the inventory; the catalog filters on
 * `vipLevelRequired: null`, so there was nothing in the store either; and the
 * seat resolver forced the tier's art over whatever was equipped, so there was
 * nothing to turn off. The unit tests cover the rules — this covers the wiring,
 * because each of those three lived in a different file.
 */

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const cosmeticsService = require("../services/cosmeticsService");
const vipService = require("../services/vipService");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

let replSet = null;
const savedEnv = {};
const realGetVipLevel = vipService.getVipLevel;
const realGetVipLevelsForUsers = vipService.getVipLevelsForUsers;

/** Who is a VIP, for this test. The real lookup reads subscriptions. */
let levelByUser = new Map();

const SUBSCRIBER = new mongoose.Types.ObjectId();
const FREE_USER = new mongoose.Types.ObjectId();
let vipFelt = null;
let vipBack = null;
let vipFrame = null;
let storeFelt = null;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) {
    savedEnv[k] = process.env[k];
  }
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "vip_entitlement" });

  // The services call `require("./vipService").getVipLevel` at call time, so
  // this patch is visible to them without any injection seam.
  vipService.getVipLevel = async (uid) => levelByUser.get(String(uid)) || null;
  // The render path resolves tiers in bulk. Patching only the single lookup
  // let the seat resolver fall through to the real subscription collection,
  // read "not a VIP", and strip the equip it was meant to be testing.
  vipService.getVipLevelsForUsers = async (uids) =>
    new Map((uids || []).map((u) => [String(u), levelByUser.get(String(u)) || null]));
  levelByUser.set(String(SUBSCRIBER), "gold");

  vipFelt = await Cosmetic.create({
    type: "table_theme", name: "VIP felt", assetKey: "vip_gold",
    price: 0, vipLevelRequired: "gold", isActive: true,
  });
  vipBack = await Cosmetic.create({
    type: "card_skin", name: "VIP back", assetKey: "vip_gold",
    price: 0, vipLevelRequired: "gold", isActive: true,
  });
  vipFrame = await Cosmetic.create({
    type: "avatar_frame", name: "VIP frame", assetKey: "skin_vip_gold",
    price: 0, vipLevelRequired: "gold", isActive: true,
  });
  storeFelt = await Cosmetic.create({
    type: "table_theme", name: "Bought felt", assetKey: "emerald_deep",
    price: 2_000_000, isActive: true,
  });
});

test.after(async () => {
  vipService.getVipLevel = realGetVipLevel;
  vipService.getVipLevelsForUsers = realGetVipLevelsForUsers;
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

// ── finding them ──────────────────────────────────────────────────────────

test("a subscriber's catalog carries their VIP felt, back and frame", async () => {
  const list = await cosmeticsService.listCatalog(SUBSCRIBER);
  const keys = list.map((x) => `${x.type}:${x.assetKey}`);
  for (const want of ["table_theme:vip_gold", "card_skin:vip_gold", "avatar_frame:skin_vip_gold"]) {
    assert.ok(keys.includes(want), `${want} is missing — nowhere to equip it from`);
  }
});

test("they arrive marked as included, at no price", async () => {
  const list = await cosmeticsService.listCatalog(SUBSCRIBER);
  const felt = list.find((x) => x.type === "table_theme" && x.assetKey === "vip_gold");
  assert.equal(felt.vipGranted, true);
  assert.equal(felt.price, 0);
});

test("a free player's catalog does not mention them", async () => {
  const list = await cosmeticsService.listCatalog(FREE_USER);
  const leaked = list.filter((x) => x.assetKey.startsWith("vip_") || x.assetKey.startsWith("skin_vip_"));
  assert.deepEqual(leaked.map((x) => x.assetKey), []);
});

test("the store listing itself never includes them", async () => {
  // `listCatalog()` with no user is the plain shop. VIP items are not stock.
  const list = await cosmeticsService.listCatalog();
  assert.equal(list.some((x) => x.vipGranted), false);
});

test("they show up as owned, without ever being bought", async () => {
  const me = await cosmeticsService.getMe(SUBSCRIBER);
  const ids = me.ownedIds.map(String);
  assert.ok(ids.includes(String(vipFelt._id)), "felt is not in the inventory");
  assert.ok(ids.includes(String(vipBack._id)), "card back is not in the inventory");
  assert.ok(ids.includes(String(vipFrame._id)), "frame is not in the inventory");

  const row = await UserCosmetics.findOne({ user: SUBSCRIBER }).lean();
  assert.ok(
    !row || !(row.ownedItems || []).some((x) => String(x) === String(vipFelt._id)),
    "nothing should have been written into ownedItems — there would be no way to take it back"
  );
});

// ── turning them on and off ───────────────────────────────────────────────

test("a subscriber equips the VIP felt they do not own", async () => {
  const me = await cosmeticsService.equipCosmetic(SUBSCRIBER, vipFelt._id);
  assert.equal(me.equipped.tableTheme, "vip_gold");
});

test("and swaps it for something they bought", async () => {
  // "غيرون اثناء الدق" — the swap has to be a real state change, not a no-op
  // the seat resolver quietly overrides.
  await UserCosmetics.updateOne(
    { user: SUBSCRIBER },
    { $addToSet: { ownedItems: storeFelt._id } }
  );
  const me = await cosmeticsService.equipCosmetic(SUBSCRIBER, storeFelt._id);
  assert.equal(me.equipped.tableTheme, "emerald_deep");
});

test("and turns it off entirely", async () => {
  const me = await cosmeticsService.unequipCosmetic(SUBSCRIBER, "table_theme");
  assert.equal(me.equipped.tableTheme, null);
});

test("a free player cannot equip a VIP item", async () => {
  await assert.rejects(
    () => cosmeticsService.equipCosmetic(FREE_USER, vipFrame._id),
    (e) => /VIP|owned/i.test(String(e.message)),
    "a non-subscriber was allowed to wear VIP art"
  );
});

test("a lower tier cannot reach a higher one", async () => {
  levelByUser.set(String(FREE_USER), "bronze");
  try {
    await assert.rejects(() => cosmeticsService.equipCosmetic(FREE_USER, vipFelt._id));
  } finally {
    levelByUser.delete(String(FREE_USER));
  }
});

test("when the subscription lapses the items simply stop being listed", async () => {
  levelByUser.delete(String(SUBSCRIBER));
  try {
    const me = await cosmeticsService.getMe(SUBSCRIBER);
    assert.equal(
      me.ownedIds.map(String).includes(String(vipFelt._id)),
      false,
      "still held after the subscription ended"
    );
    const list = await cosmeticsService.listCatalog(SUBSCRIBER);
    assert.equal(list.some((x) => x.vipGranted), false);
  } finally {
    levelByUser.set(String(SUBSCRIBER), "gold");
  }
});

// ── one tier, one set ─────────────────────────────────────────────────────

test("a tier sees its own set and no other tier's", async () => {
  // "ابو الـVIP البلاتينم يطلع عندو بس البلاتينم والذهب بس الذهبي". Entitlement
  // used to be cumulative, so a platinum member's catalog carried all four
  // tiers at once and the art stopped identifying the tier.
  const platinumFelt = await Cosmetic.create({
    type: "table_theme", name: "VIP platinum felt", assetKey: "vip_platinum",
    price: 0, vipLevelRequired: "platinum", isActive: true,
  });
  cosmeticsService.invalidateVipGateCache();

  const gold = await cosmeticsService.listCatalog(SUBSCRIBER);
  assert.ok(
    gold.some((x) => x.assetKey === "vip_gold" && x.vipGranted),
    "the gold member lost their own felt"
  );
  assert.equal(
    gold.some((x) => x.assetKey === "vip_platinum"),
    false,
    "a gold member was handed the platinum felt"
  );

  levelByUser.set(String(SUBSCRIBER), "platinum");
  try {
    const plat = await cosmeticsService.listCatalog(SUBSCRIBER);
    assert.ok(plat.some((x) => x.assetKey === "vip_platinum" && x.vipGranted));
    assert.equal(
      plat.some((x) => x.assetKey === "vip_gold" && x.vipGranted),
      false,
      "a platinum member kept the gold felt as well"
    );
  } finally {
    levelByUser.set(String(SUBSCRIBER), "gold");
    await Cosmetic.deleteOne({ _id: platinumFelt._id });
    cosmeticsService.invalidateVipGateCache();
  }
});

test("an equipped VIP item comes off by itself when the tier stops covering it", async () => {
  // Nothing writes to the equip record when a subscription changes, so the id
  // outlives the entitlement. Before this the member kept wearing the gold felt
  // after upgrading to platinum, and kept it forever once VIP lapsed.
  await cosmeticsService.equipCosmetic(SUBSCRIBER, vipFelt._id);
  const worn = await cosmeticsService.resolveEquippedPayloadForUsers([SUBSCRIBER]);
  assert.equal(worn.get(String(SUBSCRIBER)).tableTheme, "vip_gold");

  levelByUser.set(String(SUBSCRIBER), "platinum");
  try {
    // No invalidation happens on a tier change — the cached payload still says
    // vip_gold, and the entitlement has to be applied after reading it.
    const after = await cosmeticsService.resolveEquippedPayloadForUsers([SUBSCRIBER]);
    assert.equal(after.get(String(SUBSCRIBER)).tableTheme, null);
  } finally {
    levelByUser.set(String(SUBSCRIBER), "gold");
    await cosmeticsService.unequipCosmetic(SUBSCRIBER, "table_theme");
  }
});

test("a bought item is untouched by any of this", async () => {
  // The rule is about lent art. Something paid for must survive every tier
  // change, or the fix above is a way to lose purchases.
  await cosmeticsService.equipCosmetic(SUBSCRIBER, storeFelt._id);
  levelByUser.delete(String(SUBSCRIBER));
  try {
    const worn = await cosmeticsService.resolveEquippedPayloadForUsers([SUBSCRIBER]);
    assert.equal(worn.get(String(SUBSCRIBER)).tableTheme, "emerald_deep");
  } finally {
    levelByUser.set(String(SUBSCRIBER), "gold");
    await cosmeticsService.unequipCosmetic(SUBSCRIBER, "table_theme");
  }
});

// ── not for sale ──────────────────────────────────────────────────────────

test("a VIP item cannot be bought, by anyone", async () => {
  for (const uid of [SUBSCRIBER, FREE_USER]) {
    await assert.rejects(
      () => cosmeticsService.buyCosmetic(uid, vipFrame._id),
      (e) => /not for sale/i.test(String(e.message)),
      "a VIP item was purchasable"
    );
  }
});

console.log("vipCosmeticsEntitlement.integration.test.js: all tests registered");
