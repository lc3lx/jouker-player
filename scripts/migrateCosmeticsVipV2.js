"use strict";

/**
 * Idempotent migration to the Cosmetics + VIP live-service platform.
 *
 *  1. migrateCosmeticsV2   — backfill renderType/slot/category/games/currencyId/status on existing cosmetics
 *  2. migrateEquippedBySlot — backfill UserCosmetics.equippedBySlot from the legacy 3 slots
 *  3. seedVipLevels         — seed the 4 legacy VipLevel docs + apply SystemSettings price overrides
 *  4. seedVipRewards        — materialise the legacy VIP→cosmetic mapping as editable VipReward rows
 *
 * Exported as functions (run against an already-connected mongoose, e.g. in tests)
 * and runnable standalone via `node scripts/migrateCosmeticsVipV2.js`.
 * Every step is safe to re-run.
 */

const Cosmetic = require("../models/cosmeticModel");
const UserCosmetics = require("../models/userCosmeticsModel");
const CosmeticCategory = require("../models/cosmeticCategoryModel");
const CosmeticSlot = require("../models/cosmeticSlotModel");
const VipLevel = require("../models/vipLevelModel");
const VipReward = require("../models/vipRewardModel");
const SystemSettings = require("../models/systemSettingsModel");
const { LEGACY_VIP_COSMETICS } = require("../services/vipRewardService");

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function migrateCosmeticsV2() {
  await CosmeticCategory.ensureDefaults();
  await CosmeticSlot.ensureDefaults();
  // Any doc missing a v2 field; pre-save fills the rest on save().
  const docs = await Cosmetic.find({
    $or: [
      { renderType: { $exists: false } },
      { slot: null },
      { category: null },
      { status: null },
      { currencyId: { $exists: false } },
      { games: { $size: 0 } },
    ],
  });
  let updated = 0;
  for (const c of docs) {
    await c.save(); // pre-save hook backfills renderType/slot/category/games/currencyId/status
    updated += 1;
  }
  return { updated, scanned: docs.length };
}

async function migrateEquippedBySlot() {
  const rows = await UserCosmetics.find({});
  const pairs = [
    ["avatarFrame", "avatar_frame"],
    ["tableTheme", "table_theme"],
    ["cardSkin", "card_back"],
  ];
  let updated = 0;
  for (const r of rows) {
    if (!(r.equippedBySlot instanceof Map)) r.equippedBySlot = new Map();
    let dirty = false;
    for (const [field, slot] of pairs) {
      const cid = r.equipped?.[field];
      if (cid && !r.equippedBySlot.get(slot)) {
        r.equippedBySlot.set(slot, cid);
        dirty = true;
      }
    }
    if (dirty) {
      await r.save();
      updated += 1;
    }
  }
  return { updated, total: rows.length };
}

async function seedVipLevels() {
  const created = await VipLevel.ensureDefaults();
  const doc = await SystemSettings.getDefaults().catch(() => null);
  const overrides = Array.isArray(doc?.vipPackages) ? doc.vipPackages : [];
  let applied = 0;
  for (const ov of overrides) {
    const key = String(ov?.level || "").toLowerCase().trim();
    if (!key) continue;
    const set = {};
    const priceUsd = Number(ov.priceUsd);
    if (Number.isFinite(priceUsd) && priceUsd >= 0) {
      set.priceUsd = priceUsd;
      set.priceCents = Math.round(priceUsd * 100);
    }
    if (ov.isActive === false) set.enabled = false;
    if (Object.keys(set).length > 0) {
      const r = await VipLevel.updateOne({ key }, { $set: set });
      applied += r.modifiedCount || 0;
    }
  }
  return { created, overridesApplied: applied };
}

async function _upsertVipCosmetic({ type, slot, assetKey, name, promoMeta, vipLevelRequired }) {
  let doc = await Cosmetic.findOne({ type, assetKey });
  if (!doc) {
    doc = await Cosmetic.create({
      type, slot, assetKey, name,
      price: 0, currencyId: "coins", rarity: "epic",
      games: ["poker"], renderType: "png",
      isActive: true, status: "published",
      vipLevelRequired, // hidden from store (STORE_VISIBLE filters vipLevelRequired)
      promoMeta,
    });
    return { doc, created: true };
  }
  // Ensure the VIP asset metadata + gating are present on an existing doc.
  doc.promoMeta = { ...(doc.promoMeta || {}), ...promoMeta };
  if (!doc.slot) doc.slot = slot;
  if (!doc.vipLevelRequired) doc.vipLevelRequired = vipLevelRequired;
  await doc.save();
  return { doc, created: false };
}

async function seedVipRewards() {
  await VipLevel.ensureDefaults();
  let links = 0;
  let cosmeticsCreated = 0;
  for (const [level, v] of Object.entries(LEGACY_VIP_COSMETICS)) {
    const table = await _upsertVipCosmetic({
      type: "table_theme", slot: "table_theme", assetKey: v.tableTheme,
      name: `VIP ${cap(level)} Table`, promoMeta: { tableAsset: v.tableAsset }, vipLevelRequired: level,
    });
    const cards = await _upsertVipCosmetic({
      type: "card_skin", slot: "card_back", assetKey: v.cardSkin,
      name: `VIP ${cap(level)} Cards`, promoMeta: { cardAssets: v.cardAssets }, vipLevelRequired: level,
    });
    if (table.created) cosmeticsCreated += 1;
    if (cards.created) cosmeticsCreated += 1;
    for (const c of [table.doc, cards.doc]) {
      const r = await VipReward.updateOne(
        { vipLevelKey: level, cosmeticId: c._id },
        { $setOnInsert: { vipLevelKey: level, cosmeticId: c._id, autoEquip: true, enabled: true } },
        { upsert: true }
      );
      if (r.upsertedCount) links += 1;
    }
  }
  return { links, cosmeticsCreated };
}

async function runAll() {
  const cosmetics = await migrateCosmeticsV2();
  const equip = await migrateEquippedBySlot();
  const levels = await seedVipLevels();
  const rewards = await seedVipRewards();
  return { cosmetics, equip, levels, rewards };
}

module.exports = {
  migrateCosmeticsV2,
  migrateEquippedBySlot,
  seedVipLevels,
  seedVipRewards,
  runAll,
};

// Standalone runner.
if (require.main === module) {
  require("dotenv").config();
  const mongoose = require("mongoose");
  (async () => {
    const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGO_URI_MISSING");
    await mongoose.connect(uri);
    try {
      const result = await runAll();
      console.log("migrateCosmeticsVipV2 done:", JSON.stringify(result, null, 2));
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error("migrateCosmeticsVipV2 failed:", err?.message || err);
    process.exit(1);
  });
}
