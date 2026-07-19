"use strict";

/**
 * Shared table-interactions economy — paid emojis, throwables, premium gifts —
 * used identically by Poker, Tarneeb41 and Trix.
 *
 * Money rules (server-authoritative):
 *  - The server catalog is the ONLY pricing source; clients never send prices.
 *  - Sending resolves in order: consumable stock (free, decrements) →
 *    permanent ownership (charges `perUseCost`) → pay-per-use (`price`).
 *  - Every Coin movement goes through walletLedgerService inside one Mongo
 *    transaction with the inventory mutation (no partial spends).
 *
 * Abuse controls: per-user global gap + per-item cooldown + per-minute cap,
 * actionId idempotency, VIP gating, catalog `enabled` gate.
 */

const InteractionItem = require("../models/interactionItemModel");
const PlayerInventory = require("../models/playerInventoryModel");
const InteractionUsageDaily = require("../models/interactionUsageDailyModel");
const User = require("../models/userModel");
const {
  withMongoTransaction,
  ledgerWithdraw,
} = require("./walletLedgerService");
const vipService = require("./vipService");
const economyDiscountService = require("./economyDiscountService");
const economySeasonService = require("./economySeasonService");
const logger = require("../utils/logger");

// ── catalog cache ─────────────────────────────────────────────────────────────

let _catalogCache = null;
let _catalogCacheAt = 0;
const CATALOG_TTL_MS = 30_000;

async function _loadCatalog() {
  const now = Date.now();
  if (_catalogCache && now - _catalogCacheAt < CATALOG_TTL_MS) return _catalogCache;
  await InteractionItem.ensureDefaults();
  const items = await InteractionItem.find({}).sort({ sortOrder: 1 }).lean();
  _catalogCache = new Map(items.map((i) => [i.key, i]));
  _catalogCacheAt = now;
  return _catalogCache;
}

function invalidateCatalogCache() {
  _catalogCache = null;
  _catalogCacheAt = 0;
}

/** An item is shop-visible when published, not hidden, and its season (if any) is live. */
function _isVisible(item, liveSeasonKeys) {
  const published = item.status ? item.status === "published" : item.enabled;
  if (!published || item.hidden) return false;
  if (item.requiredSeason && !liveSeasonKeys.includes(item.requiredSeason)) return false;
  return true;
}

/**
 * Attach the effective (discounted) Coin price to each item without mutating the
 * base `price` — clients see `price` (list) and `effectivePrice` (what they pay).
 */
async function _withEffectivePrices(items, { isVip = false, liveSeasonKeys = [] } = {}) {
  const out = [];
  for (const i of items) {
    let eff = { price: i.price, discount: null };
    try {
      eff = await economyDiscountService.resolveEffectivePrice(i, { isVip, liveSeasonKeys });
    } catch (_) { /* pricing falls back to base on any error */ }
    out.push({ ...i, effectivePrice: eff.price, discount: eff.discount });
  }
  return out;
}

/**
 * Public catalog for pickers/shop — published, non-hidden, in-season items with
 * effective prices. Back-compatible: still returns an array; `price` unchanged.
 * @param {{ isVip?: boolean }} [opts]
 */
async function listCatalog(opts = {}) {
  const map = await _loadCatalog();
  let liveSeasonKeys = [];
  try { liveSeasonKeys = await economySeasonService.liveSeasonKeys(); } catch (_) { /* no seasons */ }
  const items = [...map.values()].filter((i) => _isVisible(i, liveSeasonKeys));
  return _withEffectivePrices(items, { isVip: !!opts.isVip, liveSeasonKeys });
}

async function getItem(itemKey) {
  const map = await _loadCatalog();
  return map.get(String(itemKey)) || null;
}

/** Increment per-item/day usage counters powering the analytics APIs. Never throws. */
async function _recordUsage({ itemKey, sends = 0, receives = 0, purchases = 0, revenue = 0 }) {
  try {
    const day = InteractionUsageDaily.dayKey();
    await InteractionUsageDaily.updateOne(
      { itemKey: String(itemKey), day },
      { $inc: { sends, receives, purchases, revenue } },
      { upsert: true }
    );
  } catch (e) {
    logger.warn("interaction_usage_record_failed", { itemKey, reason: e?.message || "unknown" });
  }
}

// ── anti-spam / idempotency (per-instance; interactions are cosmetic) ─────────

const GLOBAL_GAP_MS = Math.max(500, parseInt(process.env.INTERACTION_MIN_GAP_MS || "1200", 10));
const PER_MINUTE_CAP = Math.max(3, parseInt(process.env.INTERACTION_PER_MINUTE || "15", 10));

const _lastSendAt = new Map(); // userId -> ts
const _lastItemSendAt = new Map(); // `${userId}:${itemKey}` -> ts
const _minuteBuckets = new Map(); // userId -> { resetAt, count }
const _seenActionIds = new Map(); // `${userId}:${actionId}` -> ts

function _pruneSeenActionIds(now) {
  if (_seenActionIds.size < 5000) return;
  for (const [k, ts] of _seenActionIds) {
    if (now - ts > 5 * 60_000) _seenActionIds.delete(k);
  }
}

function _checkSpam(userId, item, actionId) {
  const now = Date.now();
  const uid = String(userId);

  if (actionId) {
    const key = `${uid}:${actionId}`;
    if (_seenActionIds.has(key)) return { ok: false, reason: "DUPLICATE_ACTION" };
    _seenActionIds.set(key, now);
    _pruneSeenActionIds(now);
  }

  const last = _lastSendAt.get(uid) || 0;
  if (now - last < GLOBAL_GAP_MS) return { ok: false, reason: "TOO_FAST" };

  const itemKey = `${uid}:${item.key}`;
  const lastItem = _lastItemSendAt.get(itemKey) || 0;
  if (now - lastItem < (item.cooldownMs || 0)) {
    return { ok: false, reason: "ITEM_COOLDOWN", retryAfterMs: item.cooldownMs - (now - lastItem) };
  }

  const bucket = _minuteBuckets.get(uid);
  if (!bucket || bucket.resetAt <= now) {
    _minuteBuckets.set(uid, { resetAt: now + 60_000, count: 1 });
  } else {
    bucket.count += 1;
    if (bucket.count > PER_MINUTE_CAP) return { ok: false, reason: "RATE_LIMITED" };
  }

  _lastSendAt.set(uid, now);
  _lastItemSendAt.set(itemKey, now);
  return { ok: true };
}

/** Test helper. */
function resetSpamStateForTests() {
  _lastSendAt.clear();
  _lastItemSendAt.clear();
  _minuteBuckets.clear();
  _seenActionIds.clear();
}

// ── inventory ────────────────────────────────────────────────────────────────

async function getInventory(userId) {
  const rows = await PlayerInventory.find({ user: userId }).lean();
  return rows.map((r) => ({
    itemKey: r.itemKey,
    quantity: r.quantity,
    unlimited: r.unlimited,
    source: r.source,
  }));
}

/**
 * Rewards hook — grant items without charging Coins.
 * source: daily_reward | vip | battle_pass | event | achievement | referral | admin_gift
 */
async function grantItem({ userId, itemKey, quantity = 1, unlimited = false, source = "admin_gift" }) {
  const item = await getItem(itemKey);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  const update = unlimited
    ? { $set: { unlimited: true, source } }
    : { $inc: { quantity: Math.max(1, quantity) }, $setOnInsert: { source } };
  await PlayerInventory.updateOne(
    { user: userId, itemKey: item.key },
    update,
    { upsert: true }
  );
  return { ok: true };
}

// ── purchase (shop) ──────────────────────────────────────────────────────────

/**
 * Buy consumable stock or permanent ownership. Atomic: Coin deduction and
 * inventory credit commit together or not at all.
 * @param {{ userId, itemKey, quantity?: number, mode?: 'consumable'|'unlimited' }} p
 */
async function purchaseItem({ userId, itemKey, quantity = 1, mode = "consumable" }) {
  const item = await getItem(itemKey);
  if (!item || !item.enabled) return { ok: false, reason: "ITEM_NOT_FOUND" };
  const isVip = await _vipGate(userId);
  if (item.vipOnly && !isVip) return { ok: false, reason: "VIP_REQUIRED" };

  const qty = Math.max(1, Math.min(99, Math.floor(quantity)));
  let liveSeasonKeys = [];
  try { liveSeasonKeys = await economySeasonService.liveSeasonKeys(); } catch (_) { /* no seasons */ }

  let cost;
  if (mode === "unlimited") {
    if (item.unlimitedPrice == null) return { ok: false, reason: "NOT_PURCHASABLE" };
    const eff = await economyDiscountService.resolveEffectivePrice(item, { isVip, liveSeasonKeys, basePriceField: "unlimitedPrice" });
    cost = eff.price;
  } else {
    const eff = await economyDiscountService.resolveEffectivePrice(item, { isVip, liveSeasonKeys });
    cost = eff.price * qty;
  }

  try {
    await withMongoTransaction(async (session) => {
      if (cost > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: cost,
          ledgerType: "interaction_purchase",
          meta: { itemKey: item.key, mode, quantity: qty, currencyId: item.currencyId || "coins" },
        });
      }
      const update = mode === "unlimited"
        ? { $set: { unlimited: true, source: "purchase" } }
        : { $inc: { quantity: qty }, $setOnInsert: { source: "purchase" } };
      await PlayerInventory.updateOne(
        { user: userId, itemKey: item.key },
        update,
        { upsert: true, session: session || undefined }
      );
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") return { ok: false, reason: "INSUFFICIENT_BALANCE" };
    throw e;
  }
  await _recordUsage({ itemKey: item.key, purchases: mode === "unlimited" ? 1 : qty, revenue: cost });
  return { ok: true, itemKey: item.key, mode, quantity: qty, cost };
}

async function _vipGate(userId) {
  try {
    const map = await vipService.getVipLevelsForUsers([String(userId)]);
    const lvl = map.get(String(userId));
    return lvl != null && String(lvl).length > 0;
  } catch (_) {
    return false;
  }
}

// ── send (the core interaction) ──────────────────────────────────────────────

/**
 * Validate + charge + build the broadcast event for one interaction send.
 * Charging order: consumable stock → unlimited (perUseCost) → pay-per-use.
 */
async function sendInteraction({ userId, itemKey, targetUserId = null, actionId = null }) {
  const item = await getItem(itemKey);
  if (!item || !item.enabled) return { ok: false, reason: "ITEM_NOT_FOUND" };

  const isVip = await _vipGate(userId);
  if (item.vipOnly && !isVip) return { ok: false, reason: "VIP_REQUIRED" };

  const spam = _checkSpam(userId, item, actionId);
  if (!spam.ok) return spam;

  // Pay-per-use uses the effective (discounted) shop price; owners pay perUseCost.
  let payPerUse = item.price;
  try {
    let liveSeasonKeys = [];
    try { liveSeasonKeys = await economySeasonService.liveSeasonKeys(); } catch (_) { /* none */ }
    const eff = await economyDiscountService.resolveEffectivePrice(item, { isVip, liveSeasonKeys });
    payPerUse = eff.price;
  } catch (_) { /* fall back to base price */ }

  let charge = { mode: "pay_per_use", cost: payPerUse };
  try {
    await withMongoTransaction(async (session) => {
      const opts = session ? { session } : {};
      // 1) consumable stock — free send, quantity decrements atomically.
      const consumed = await PlayerInventory.findOneAndUpdate(
        { user: userId, itemKey: item.key, quantity: { $gt: 0 } },
        { $inc: { quantity: -1 } },
        { ...opts, new: true }
      );
      if (consumed) {
        charge = { mode: "consumable", cost: 0, remaining: consumed.quantity };
        return;
      }
      // 2) permanent ownership — optional per-use Coin cost.
      const owned = await PlayerInventory.findOne(
        { user: userId, itemKey: item.key, unlimited: true },
        null,
        opts
      );
      const cost = owned ? item.perUseCost : payPerUse;
      charge = { mode: owned ? "unlimited" : "pay_per_use", cost };
      if (cost > 0) {
        await ledgerWithdraw({
          session,
          userId,
          amount: cost,
          ledgerType: "interaction_use",
          meta: { itemKey: item.key, mode: charge.mode, targetUserId, currencyId: item.currencyId || "coins" },
        });
      }
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") return { ok: false, reason: "INSUFFICIENT_BALANCE" };
    logger.warn("interaction_send_failed", { userId: String(userId), itemKey, reason: e.message });
    return { ok: false, reason: "SEND_FAILED" };
  }

  await _recordUsage({
    itemKey: item.key,
    sends: 1,
    receives: targetUserId ? 1 : 0,
    revenue: charge.cost || 0,
  });

  const sender = await User.findById(userId).select("name").lean().catch(() => null);
  return {
    ok: true,
    charge,
    event: {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      itemKey: item.key,
      icon: item.icon,
      animation: item.animation,
      category: item.category,
      rarity: item.rarity,
      senderId: String(userId),
      senderName: sender?.name || "Player",
      targetUserId: targetUserId ? String(targetUserId) : null,
      at: Date.now(),
    },
  };
}

module.exports = {
  listCatalog,
  getItem,
  getInventory,
  grantItem,
  purchaseItem,
  sendInteraction,
  invalidateCatalogCache,
  resetSpamStateForTests,
};
