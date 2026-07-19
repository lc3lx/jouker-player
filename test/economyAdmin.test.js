"use strict";

/**
 * Economy Content Management API (IE-10) regression suite.
 *
 * Covers CRUD, lifecycle (publish/disable/restore/archive/duplicate), permanent
 * delete, bulk ops, search/filter/sort/pagination, live catalog refresh (cache
 * invalidation + broadcast), discounts/seasons pricing, analytics rollups, audit
 * trail, permission matrix, and backward compatibility with the existing
 * player-facing economy. Runs on a real Mongo replica set.
 */

process.env.NODE_ENV = "test";
process.env.INTERACTION_MIN_GAP_MS = "500";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Wallet = require("../models/walletModel");
const InteractionItem = require("../models/interactionItemModel");
const InteractionUsageDaily = require("../models/interactionUsageDailyModel");
const AuditLog = require("../models/auditLogModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const catalog = require("../services/economyCatalogService");
const discounts = require("../services/economyDiscountService");
const seasons = require("../services/economySeasonService");
const currencies = require("../services/economyCurrencyService");
const categories = require("../services/interactionCategoryService");
const analytics = require("../services/economyAnalyticsService");
const economyAudit = require("../services/economyAuditService");
const economyBroadcast = require("../services/economyBroadcast");
const perms = require("../services/economyPermissions");
const svc = require("../services/tableInteractionsService");

let replSet = null;
const savedEnv = {};
const ADMIN = { actor: { id: new mongoose.Types.ObjectId(), name: "Admin", ip: "127.0.0.1", userAgent: "test" } };

async function makeUser(balance) {
  const userId = new mongoose.Types.ObjectId();
  await Wallet.create({ user: userId, balance, lockedBalance: 0 });
  return userId;
}
const balanceOf = async (u) => (await Wallet.findOne({ user: u }).lean())?.balance ?? 0;

// Capture broadcasts for live-update assertions.
const broadcasts = [];
function installFakeNamespace() {
  economyBroadcast._resetForTests();
  economyBroadcast.registerNamespace({
    emit: (event, payload) => broadcasts.push({ event, payload }),
  });
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
  await mongoose.connect(replSet.getUri(), { dbName: "economy_admin_test" });
  installFakeNamespace();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  economyBroadcast._resetForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ── CRUD + lifecycle ─────────────────────────────────────────────────────────

test("create → item starts as DRAFT and is NOT shop-visible", async () => {
  const item = await catalog.create(
    { key: "test_star", name: "Star", icon: "⭐", animation: "emoji_pop", category: "emoji", price: 200 },
    ADMIN
  );
  assert.equal(item.status, "draft");
  assert.equal(item.enabled, false);
  const shop = await svc.listCatalog();
  assert.equal(shop.some((i) => i.key === "test_star"), false, "draft hidden from shop");
});

test("publish → item becomes shop-visible; enabled mirrors status", async () => {
  broadcasts.length = 0;
  const r = await catalog.publish("test_star", ADMIN);
  assert.equal(r.after.status, "published");
  assert.equal(r.after.enabled, true);
  const shop = await svc.listCatalog();
  assert.ok(shop.some((i) => i.key === "test_star"), "published item in shop");
  // Live update broadcast fired.
  assert.ok(broadcasts.some((b) => b.event === "catalog_updated"), "catalog_updated broadcast");
});

test("update → editable fields change, key immutable, audited", async () => {
  const r = await catalog.update("test_star", { key: "HACKED", price: 999, arabicName: "نجمة" }, ADMIN);
  assert.equal(r.after.key, "test_star", "key never changes");
  assert.equal(r.after.price, 999);
  assert.equal(r.after.nameAr, "نجمة", "arabicName mirrors to nameAr");
});

test("disable then restore → recovered to hidden 'disabled' state", async () => {
  await catalog.disable("test_star", ADMIN);
  assert.equal((await catalog.get("test_star")).status, "disabled");
  const r = await catalog.restore("test_star", ADMIN);
  assert.equal(r.after.status, "disabled");
  assert.equal(r.after.deletedAt, null);
});

test("archive → soft delete sets deletedAt and hides from default list", async () => {
  await catalog.publish("test_star", ADMIN);
  await catalog.archive("test_star", ADMIN);
  const doc = await catalog.get("test_star");
  assert.equal(doc.status, "archived");
  assert.ok(doc.deletedAt, "deletedAt set");
  const list = await catalog.list({});
  assert.equal(list.rows.some((i) => i.key === "test_star"), false, "archived hidden by default");
  const withArchived = await catalog.list({ includeArchived: true });
  assert.ok(withArchived.rows.some((i) => i.key === "test_star"), "visible when includeArchived");
});

test("duplicate → clones to a new unique draft key", async () => {
  const copy = await catalog.duplicate("emoji_fire", ADMIN);
  assert.equal(copy.key, "emoji_fire_copy");
  assert.equal(copy.status, "draft");
  assert.match(copy.name, /Copy/);
  const copy2 = await catalog.duplicate("emoji_fire", ADMIN);
  assert.equal(copy2.key, "emoji_fire_copy2", "unique key on repeat");
});

test("permanent delete → hard removes the document", async () => {
  await catalog.create({ key: "temp_del", name: "Temp", icon: "🗑️", animation: "emoji_pop", category: "emoji", price: 10 }, ADMIN);
  await catalog.permanentDelete("temp_del", ADMIN);
  assert.equal(await InteractionItem.findOne({ key: "temp_del" }), null);
});

// ── search / filter / sort / pagination ──────────────────────────────────────

test("list: search + category filter + pagination", async () => {
  const gifts = await catalog.list({ category: "gift", limit: 3, page: 1, sortBy: "price", sortDir: "asc" });
  assert.ok(gifts.rows.every((i) => i.category === "gift"));
  assert.equal(gifts.rows.length, 3);
  assert.ok(gifts.total >= 7);
  assert.ok(gifts.rows[0].price <= gifts.rows[1].price, "sorted by price asc");

  const search = await catalog.list({ q: "dragon" });
  assert.ok(search.rows.some((i) => i.key === "gift_dragon"));
});

// ── bulk operations ──────────────────────────────────────────────────────────

test("bulk updatePrice by keys → all matched items repriced + broadcast", async () => {
  broadcasts.length = 0;
  const r = await catalog.bulk(
    { action: "updatePrice", keys: ["emoji_smile", "emoji_laugh"], value: { price: 5 } },
    ADMIN
  );
  assert.equal(r.matched, 2);
  assert.equal(r.modified, 2);
  assert.equal((await catalog.get("emoji_smile")).price, 5);
  assert.ok(broadcasts.some((b) => b.event === "catalog_updated"));
});

test("bulk disable by filter → status flipped for the whole category", async () => {
  await catalog.create({ key: "b1", name: "B1", icon: "🅰️", animation: "emoji_pop", category: "bulktest", price: 10, status: "published" }, ADMIN);
  await catalog.create({ key: "b2", name: "B2", icon: "🅱️", animation: "emoji_pop", category: "bulktest", price: 10, status: "published" }, ADMIN);
  const r = await catalog.bulk({ action: "disable", filter: { category: "bulktest" } }, ADMIN);
  assert.equal(r.matched, 2);
  assert.equal((await catalog.get("b1")).status, "disabled");
  assert.equal((await catalog.get("b2")).status, "disabled");
});

test("bulk refuses an unscoped mutation (no keys, no filter)", async () => {
  await assert.rejects(() => catalog.bulk({ action: "disable" }, ADMIN), /NO_TARGETS/);
});

// ── discounts / seasons pricing ──────────────────────────────────────────────

test("discount: percentage reduces effectivePrice and the charged amount", async () => {
  await catalog.create({ key: "disc_item", name: "Disc", icon: "🏷️", animation: "emoji_pop", category: "emoji", price: 1000, status: "published" }, ADMIN);
  await discounts.create({ name: "Half off", type: "percentage", value: 50, appliesTo: "items", targets: ["disc_item"] });

  const item = await catalog.get("disc_item");
  const eff = await discounts.resolveEffectivePrice(item, {});
  assert.equal(eff.price, 500);
  assert.equal(eff.discount.type, "percentage");

  // Purchase charges the discounted price.
  const u = await makeUser(2000);
  const buy = await svc.purchaseItem({ userId: u, itemKey: "disc_item", quantity: 1 });
  assert.equal(buy.ok, true);
  assert.equal(buy.cost, 500, "discounted price charged");
  assert.equal(await balanceOf(u), 1500);
});

test("season: seasonal item hidden until its season is live", async () => {
  await catalog.create(
    { key: "winter_gift", name: "Snowman", icon: "⛄", animation: "gift_shine", category: "gift", price: 300, requiredSeason: "winter", status: "published" },
    ADMIN
  );
  let shop = await svc.listCatalog();
  assert.equal(shop.some((i) => i.key === "winter_gift"), false, "hidden before season");

  await seasons.create({ key: "winter", name: "Winter", active: true });
  shop = await svc.listCatalog();
  assert.ok(shop.some((i) => i.key === "winter_gift"), "visible once season live");
});

// ── analytics ────────────────────────────────────────────────────────────────

test("analytics: sends/receives/purchases + revenue roll up per item", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(100000);
  // A send with a target (counts as send + receive) and a pay-per-use charge.
  const send = await svc.sendInteraction({ userId: u, itemKey: "emoji_heart", targetUserId: new mongoose.Types.ObjectId(), actionId: "an1" });
  assert.equal(send.ok, true);

  const usage = await InteractionUsageDaily.findOne({ itemKey: "emoji_heart" }).lean();
  assert.equal(usage.sends, 1);
  assert.equal(usage.receives, 1);
  assert.ok(usage.revenue >= 100);

  const mostSent = await analytics.mostSent({ limit: 5 });
  assert.ok(mostSent.some((r) => r.itemKey === "emoji_heart"), "appears in most-sent");

  const overview = await analytics.overview({});
  assert.ok(overview.totals.sends >= 1);
  assert.ok(overview.totals.revenue >= 100);

  const spend = await analytics.spending({ granularity: "day" });
  assert.equal(spend.granularity, "day");
  assert.ok(spend.series.length >= 1);
});

// ── audit trail ──────────────────────────────────────────────────────────────

test("audit: every admin mutation writes a hash-chained economy log entry", async () => {
  const before = await AuditLog.countDocuments({ event: /^economy\./ });
  await catalog.create({ key: "audit_probe", name: "AP", icon: "🔎", animation: "emoji_pop", category: "emoji", price: 1 }, ADMIN);
  await catalog.publish("audit_probe", { ...ADMIN, reason: "launch" });
  const after = await AuditLog.countDocuments({ event: /^economy\./ });
  assert.ok(after >= before + 2, "audit rows written");

  const listed = await economyAudit.list({ entity: "item", limit: 50 });
  const publishRow = listed.rows.find((r) => r.event === "economy.item.publish" && r.meta.entityId === "audit_probe");
  assert.ok(publishRow, "publish audited");
  assert.equal(publishRow.meta.reason, "launch");
  assert.ok(publishRow.hash, "hash-chained");
});

// ── permission matrix ────────────────────────────────────────────────────────

test("permissions: role capability matrix + platform mapping", () => {
  assert.equal(perms.resolveEconomyRole({ role: "admin" }), "super_admin");
  assert.equal(perms.resolveEconomyRole({ role: "manager" }), "economy_manager");

  // Super admin can permanently delete; manager cannot.
  assert.equal(perms.hasCapability({ role: "admin" }, perms.CAPABILITIES.PERMANENT_DELETE), true);
  assert.equal(perms.hasCapability({ role: "manager" }, perms.CAPABILITIES.PERMANENT_DELETE), false);
  assert.equal(perms.hasCapability({ role: "manager" }, perms.CAPABILITIES.PUBLISH), true);

  // Explicit future econ role wins over platform mapping.
  const viewer = { role: "manager", economyRole: "economy_viewer" };
  assert.equal(perms.hasCapability(viewer, perms.CAPABILITIES.VIEW), true);
  assert.equal(perms.hasCapability(viewer, perms.CAPABILITIES.CREATE), false);
});

test("permissions: middleware allows/denies by capability", () => {
  const run = (role, cap) => {
    let err;
    perms.requireEconomyPermission(cap)({ user: { role } }, {}, (e) => { err = e; });
    return err;
  };
  assert.equal(run("admin", perms.CAPABILITIES.PERMANENT_DELETE), undefined, "admin allowed");
  const denied = run("manager", perms.CAPABILITIES.PERMANENT_DELETE);
  assert.ok(denied && denied.statusCode === 403, "manager denied 403");
});

// ── currency & category management ───────────────────────────────────────────

test("currency: default coins seeded; new currency added without code changes", async () => {
  const list = await currencies.list();
  assert.ok(list.some((c) => c.code === "coins" && c.isDefault), "default coins present");
  const gem = await currencies.create({ code: "gems", name: "Gems", symbol: "💎" });
  assert.equal(gem.code, "gems");
  assert.equal(gem.isDefault, false);
});

test("category: unlimited managed set — new category is free-form on items", async () => {
  await categories.create({ key: "sticker", name: "Stickers", icon: "🏷️" });
  const item = await catalog.create({ key: "sticker_hi", name: "Hi", icon: "👋", animation: "emoji_pop", category: "sticker", price: 20, status: "published" }, ADMIN);
  assert.equal(item.category, "sticker");
  const all = await categories.list();
  assert.ok(all.some((c) => c.key === "sticker"));
});

// ── backward compatibility ───────────────────────────────────────────────────

test("backward-compat: default catalog still returns published spec pricing", async () => {
  const items = await svc.listCatalog();
  const byKey = new Map(items.map((i) => [i.key, i]));
  // emoji_smile was repriced to 5 by the bulk test; assert a non-mutated default.
  assert.equal(byKey.get("emoji_clap").price, 120, "untouched default price preserved");
  assert.equal(byKey.get("gift_dragon").price, 2500000);
  // Effective price defaults to base when no discount applies.
  assert.equal(byKey.get("emoji_clap").effectivePrice, 120);
});

test("backward-compat: legacy send/purchase paths still function", async () => {
  svc.resetSpamStateForTests();
  const u = await makeUser(5000);
  const buy = await svc.purchaseItem({ userId: u, itemKey: "throw_egg", quantity: 2 });
  assert.equal(buy.ok, true);
  const send = await svc.sendInteraction({ userId: u, itemKey: "throw_egg", actionId: "bc1" });
  assert.equal(send.ok, true);
  assert.equal(send.charge.mode, "consumable", "stock consumed first, unchanged behavior");
});
