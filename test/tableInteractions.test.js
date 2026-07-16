"use strict";

/**
 * Table-interactions economy regression suite — catalog seed, atomic purchase,
 * charging order (consumable → unlimited → pay-per-use), cooldowns, idempotency
 * and VIP gating, on a real Mongo replica set.
 */

process.env.NODE_ENV = "test";
process.env.INTERACTION_MIN_GAP_MS = "500";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const InteractionItem = require("../models/interactionItemModel");
const PlayerInventory = require("../models/playerInventoryModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const svc = require("../services/tableInteractionsService");

let replSet = null;
const savedEnv = {};

async function makeUser(balance) {
  const userId = new mongoose.Types.ObjectId();
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}

async function balanceOf(userId) {
  const w = await Wallet.findOne({ user: userId }).lean();
  return w ? w.balance : 0;
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
  await mongoose.connect(replSet.getUri(), { dbName: "interactions_test" });
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

test("catalog seeds the spec pricing exactly once (idempotent)", async () => {
  const items = await svc.listCatalog();
  assert.ok(items.length >= 21, "all default items present");
  const byKey = new Map(items.map((i) => [i.key, i]));
  assert.equal(byKey.get("emoji_smile").price, 50);
  assert.equal(byKey.get("emoji_fire").price, 150);
  assert.equal(byKey.get("throw_tomato").price, 250);
  assert.equal(byKey.get("throw_moneyrain").price, 5000);
  assert.equal(byKey.get("gift_ring").price, 25000);
  assert.equal(byKey.get("gift_dragon").price, 2500000);
  // Re-seeding never duplicates.
  const before = await InteractionItem.countDocuments({});
  await InteractionItem.ensureDefaults();
  assert.equal(await InteractionItem.countDocuments({}), before);
});

test("purchase (consumable): coins deducted atomically, stock credited", async () => {
  const u = await makeUser(1000);
  const r = await svc.purchaseItem({ userId: u, itemKey: "throw_tomato", quantity: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.cost, 750);
  assert.equal(await balanceOf(u), 250);
  const inv = await svc.getInventory(u);
  assert.deepEqual(
    inv.find((i) => i.itemKey === "throw_tomato").quantity,
    3
  );
  const tx = await WalletTransaction.findOne({ userId: u, type: "interaction_purchase" }).lean();
  assert.ok(tx, "ledger row written");
  assert.equal(tx.amount, 750);
});

test("purchase rejected on insufficient balance — nothing changes", async () => {
  const u = await makeUser(100);
  const r = await svc.purchaseItem({ userId: u, itemKey: "gift_dragon", quantity: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "INSUFFICIENT_BALANCE");
  assert.equal(await balanceOf(u), 100, "no partial deduction");
  assert.equal((await svc.getInventory(u)).length, 0, "no inventory credited");
});

test("send: consumable stock consumed first — free send, quantity decrements", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(500);
  await PlayerInventory.create({ user: u, itemKey: "throw_egg", quantity: 2 });

  const r = await svc.sendInteraction({ userId: u, itemKey: "throw_egg", actionId: "a1" });
  assert.equal(r.ok, true);
  assert.equal(r.charge.mode, "consumable");
  assert.equal(r.charge.cost, 0);
  assert.equal(await balanceOf(u), 500, "no coins charged when consuming stock");
  const inv = await svc.getInventory(u);
  assert.equal(inv.find((i) => i.itemKey === "throw_egg").quantity, 1);
  assert.equal(r.event.itemKey, "throw_egg");
  assert.equal(r.event.animation, "throw_crack");
});

test("send: pay-per-use charges the catalog price when no stock", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(500);
  const r = await svc.sendInteraction({ userId: u, itemKey: "emoji_heart", actionId: "b1" });
  assert.equal(r.ok, true);
  assert.equal(r.charge.mode, "pay_per_use");
  assert.equal(r.charge.cost, 100);
  assert.equal(await balanceOf(u), 400);
  const tx = await WalletTransaction.findOne({ userId: u, type: "interaction_use" }).lean();
  assert.equal(tx.amount, 100);
});

test("send: unlimited ownership charges perUseCost instead of price", async () => {
  svc.resetSpamStateForTests();
  await InteractionItem.updateOne(
    { key: "throw_rose" },
    { $set: { unlimitedPrice: 5000, perUseCost: 50 } }
  );
  svc.invalidateCatalogCache();

  const u = await makeUser(10000);
  const buy = await svc.purchaseItem({ userId: u, itemKey: "throw_rose", mode: "unlimited" });
  assert.equal(buy.ok, true);
  assert.equal(await balanceOf(u), 5000);

  const r = await svc.sendInteraction({ userId: u, itemKey: "throw_rose", actionId: "c1" });
  assert.equal(r.ok, true);
  assert.equal(r.charge.mode, "unlimited");
  assert.equal(r.charge.cost, 50, "perUseCost, not the 750 price");
  assert.equal(await balanceOf(u), 4950);
});

test("send rejected when broke (pay-per-use) — no partial state", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(10);
  const r = await svc.sendInteraction({ userId: u, itemKey: "emoji_smile", actionId: "d1" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "INSUFFICIENT_BALANCE");
  assert.equal(await balanceOf(u), 10);
});

test("anti-spam: global gap + duplicate actionId + item cooldown", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(100000);

  const first = await svc.sendInteraction({ userId: u, itemKey: "emoji_smile", actionId: "e1" });
  assert.equal(first.ok, true);

  // Same actionId → idempotent rejection (never double-charged).
  const dup = await svc.sendInteraction({ userId: u, itemKey: "emoji_smile", actionId: "e1" });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "DUPLICATE_ACTION");

  // Too fast (fresh actionId, inside the global gap).
  const fast = await svc.sendInteraction({ userId: u, itemKey: "emoji_laugh", actionId: "e2" });
  assert.equal(fast.ok, false);
  assert.equal(fast.reason, "TOO_FAST");

  const balAfter = await balanceOf(u);
  assert.equal(balAfter, 100000 - 50, "exactly one charge went through");
});

test("vipOnly items are gated for non-VIP players", async () => {
  svc.resetSpamStateForTests();
  await InteractionItem.updateOne({ key: "gift_castle" }, { $set: { vipOnly: true } });
  svc.invalidateCatalogCache();

  const u = await makeUser(5000000);
  const buy = await svc.purchaseItem({ userId: u, itemKey: "gift_castle" });
  assert.equal(buy.ok, false);
  assert.equal(buy.reason, "VIP_REQUIRED");
  const send = await svc.sendInteraction({ userId: u, itemKey: "gift_castle", actionId: "f1" });
  assert.equal(send.ok, false);
  assert.equal(send.reason, "VIP_REQUIRED");
  assert.equal(await balanceOf(u), 5000000, "no charge on gated attempts");
});

test("rewards hook: grantItem credits stock / unlimited without coins", async () => {
  const u = await makeUser(0);
  await svc.grantItem({ userId: u, itemKey: "throw_flower", quantity: 5, source: "daily_reward" });
  await svc.grantItem({ userId: u, itemKey: "emoji_fire", unlimited: true, source: "vip" });
  const inv = await svc.getInventory(u);
  assert.equal(inv.find((i) => i.itemKey === "throw_flower").quantity, 5);
  assert.equal(inv.find((i) => i.itemKey === "emoji_fire").unlimited, true);
  assert.equal(await balanceOf(u), 0, "rewards never touch coins");
});
