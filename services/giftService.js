"use strict";

/**
 * Player-to-player gifting from the profile popup. Extensible by `type`:
 *   - coins:    debit sender, credit receiver (atomic ledger transfer)
 *   - cosmetic: sender buys a store cosmetic for the receiver's inventory
 *   - vip:      gift a VIP membership (gated behind a configured coin price;
 *               VIP stays real-money by default → NOT_GIFTABLE unless enabled)
 *
 * A new gift type = one new branch in `GIFT_TYPES`; the endpoint/UI need no
 * structural change. All Coin movements go through walletLedgerService inside a
 * Mongo transaction. Abuse controls: self/blocked guards, bounds, per-minute cap.
 */

const mongoose = require("mongoose");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const User = require("../models/userModel");
const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const VipLevel = require("../models/vipLevelModel");
const { withMongoTransaction, ledgerWithdraw, ledgerDeposit } = require("./walletLedgerService");
const friendService = require("./friendService");
const cosmeticsService = require("./cosmeticsService");
const playerProfileService = require("./playerProfileService");

const COINS_MIN = Math.max(1, parseInt(process.env.GIFT_COINS_MIN || "100", 10));
const COINS_MAX = Math.max(COINS_MIN, parseInt(process.env.GIFT_COINS_MAX || "10000000", 10));
const PER_MINUTE = Math.max(1, parseInt(process.env.GIFT_PER_MINUTE || "10", 10));

const _minuteBuckets = new Map(); // senderId -> { resetAt, count }

function toObjectId(id) {
  try { return new mongoose.Types.ObjectId(String(id)); } catch { return null; }
}

function _rateOk(senderId) {
  const uid = String(senderId);
  const now = Date.now();
  const b = _minuteBuckets.get(uid);
  if (!b || b.resetAt <= now) {
    _minuteBuckets.set(uid, { resetAt: now + 60000, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= PER_MINUTE;
}

async function _assertSendable(senderId, targetId) {
  if (String(senderId) === String(targetId)) throw new ApiError("Cannot gift yourself", 400);
  const target = await User.findById(targetId).select("_id active").lean();
  if (!target || target.active === false) throw new ApiError("User not found", 404);
  if (await friendService.isBlocked(senderId, targetId)) throw new ApiError("Player is blocked", 403);
  if (!_rateOk(senderId)) throw new ApiError("Too many gifts, slow down", 429);
}

// ── gift type handlers ───────────────────────────────────────────────────────

async function _giftCoins(senderId, targetId, payload) {
  const amount = Math.floor(Number(payload.amount) || 0);
  if (amount < COINS_MIN || amount > COINS_MAX) {
    throw new ApiError(`Coin gift must be between ${COINS_MIN} and ${COINS_MAX}`, 400);
  }
  try {
    await withMongoTransaction(async (session) => {
      await ledgerWithdraw({ session, userId: senderId, amount, ledgerType: "gift_sent", meta: { to: String(targetId) } });
      await ledgerDeposit({ session, userId: targetId, amount, ledgerType: "gift_received", meta: { from: String(senderId) } });
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") throw new ApiError("Insufficient balance", 402);
    throw e;
  }
  return { type: "coins", amount };
}

async function _giftCosmetic(senderId, targetId, payload) {
  const cosmeticId = toObjectId(payload.cosmeticId);
  if (!cosmeticId) throw new ApiError("Invalid cosmetic id", 400);
  const item = await Cosmetic.findOne({ _id: cosmeticId, isActive: true }).lean();
  if (!item) throw new ApiError("Cosmetic not found", 404);
  if (item.type === "bundle") throw new ApiError("Bundles cannot be gifted", 400);

  const targetRow = await UserCosmetics.findOne({ user: targetId }).select("ownedItems").lean();
  if ((targetRow?.ownedItems || []).some((id) => String(id) === String(cosmeticId))) {
    throw new ApiError("Player already owns this item", 400);
  }
  const price = Math.max(0, Math.floor(Number(item.price) || 0));
  try {
    await withMongoTransaction(async (session) => {
      if (price > 0) {
        await ledgerWithdraw({ session, userId: senderId, amount: price, ledgerType: "cosmetic_gift", meta: { to: String(targetId), cosmeticId: String(cosmeticId), assetKey: item.assetKey } });
      }
      await UserCosmetics.updateOne(
        { user: targetId },
        { $addToSet: { ownedItems: cosmeticId }, $setOnInsert: { user: targetId } },
        { upsert: true, session: session || undefined }
      );
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") throw new ApiError("Insufficient balance", 402);
    throw e;
  }
  cosmeticsService.invalidateEquippedCache(targetId);
  return { type: "cosmetic", cosmeticId: String(cosmeticId), assetKey: item.assetKey, cost: price };
}

async function _giftVip(senderId, targetId, payload) {
  const level = String(payload.level || "").toLowerCase().trim();
  const vl = await VipLevel.findOne({ key: level, enabled: true }).lean();
  if (!vl) throw new ApiError("Invalid VIP level", 400);
  // VIP stays real-money by default: only giftable when an admin sets a coin price.
  const coinPrice = Math.max(0, Math.floor(Number(vl.promo?.giftCoinPrice) || 0));
  if (coinPrice <= 0) throw new ApiError("This VIP level is not giftable", 400);
  const days = Math.max(1, Math.min(365, Math.floor(Number(payload.days) || vl.durationDays || 30)));

  // Debit sender first; grant membership; refund on grant failure (separate txns).
  try {
    await withMongoTransaction(async (session) => {
      await ledgerWithdraw({ session, userId: senderId, amount: coinPrice, ledgerType: "vip_gift", meta: { to: String(targetId), level, days } });
    });
  } catch (e) {
    if (e.message === "INSUFFICIENT_BALANCE") throw new ApiError("Insufficient balance", 402);
    throw e;
  }
  try {
    const vipService = require("./vipService");
    await vipService.applyMembershipChange({ userId: targetId, level, kind: "admin_gift", days, note: `player_gift_from_${senderId}` });
  } catch (e) {
    // Best-effort refund so the sender is not charged for a failed grant.
    await withMongoTransaction(async (session) => {
      await ledgerDeposit({ session, userId: senderId, amount: coinPrice, ledgerType: "gift_received", meta: { refund: "vip_gift_failed" } });
    }).catch(() => {});
    logger.warn("vip_gift_failed", { reason: e?.message || "unknown" });
    throw new ApiError("Could not grant VIP gift", 500);
  }
  return { type: "vip", level, days, cost: coinPrice };
}

const GIFT_TYPES = {
  coins: _giftCoins,
  cosmetic: _giftCosmetic,
  vip: _giftVip,
};

/**
 * Send a gift. @param {{ senderId, targetId, type, ...payload }} p
 */
async function sendGift({ senderId, targetId, type, ...payload }) {
  const handler = GIFT_TYPES[String(type)];
  if (!handler) throw new ApiError("Unsupported gift type", 400);
  await _assertSendable(senderId, targetId);
  const result = await handler(senderId, targetId, payload);
  playerProfileService.invalidate(targetId); // refresh receiver's cached profile
  return { ok: true, ...result };
}

module.exports = { sendGift, GIFT_TYPES };
