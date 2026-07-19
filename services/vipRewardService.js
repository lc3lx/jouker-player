"use strict";

/**
 * VIP → cosmetic rewards (DB-backed, sync-cached). Replaces the hardcoded
 * config/vipCosmeticsConfig.js. Admin assigns any cosmetic to any VIP level; this
 * service resolves a level to the SAME legacy shape the poker seat/felt resolver
 * expects (`tableTheme/tableAsset/cardSkin/cardAssets`) PLUS a generic `grants`
 * list, so callers stay synchronous and behavior is unchanged until admins edit.
 *
 * Seeded from the legacy mapping so day-one output is byte-identical; `refresh()`
 * overlays DB rewards and is called on boot + after admin reward edits.
 */

const logger = require("../utils/logger");

/** Legacy VIP → table/card cosmetics (seed + fallback). Preserves exact assets. */
const LEGACY_VIP_COSMETICS = {
  bronze: {
    tableTheme: "vip_bronze", cardSkin: "vip_bronze",
    tableAsset: "vip/bronze/taple_vip_bronze.png",
    cardAssets: ["vip/bronze/cards1_vip_bronze.png", "vip/bronze/cards2_vip_bronze.png"],
  },
  silver: {
    tableTheme: "vip_silver", cardSkin: "vip_silver",
    tableAsset: "vip/silver/taple_vip_silver.png",
    cardAssets: ["vip/silver/cards1_vip_silver.png", "vip/silver/cards2_vip_silver.png"],
  },
  gold: {
    tableTheme: "vip_gold", cardSkin: "vip_gold",
    tableAsset: "vip/gold/taple_vip_golde.png",
    cardAssets: ["vip/gold/cards1_vip_golde.png", "vip/gold/cards2_vip_golde.png"],
  },
  platinum: {
    tableTheme: "vip_platinum", cardSkin: "vip_platinum",
    tableAsset: "vip/platinum/taple_vip_platinum.png",
    cardAssets: ["vip/platinum/cards1_vip_platinum.png", "vip/platinum/cards2_vip_platinum.png"],
  },
};

function _seed() {
  const map = new Map();
  for (const [level, v] of Object.entries(LEGACY_VIP_COSMETICS)) {
    map.set(level, { ...v, grants: [] });
  }
  return map;
}

let _byLevel = _seed();
let _warm = false;
let _refreshing = false;

function _slotOf(c) {
  if (c.slot) return c.slot;
  if (c.type === "table_theme") return "table_theme";
  if (c.type === "card_skin") return "card_back";
  if (c.type === "avatar_frame") return "avatar_frame";
  return c.type || null;
}

function _project(cosmetics, fallback) {
  const out = { tableTheme: null, tableAsset: null, cardSkin: null, cardAssets: null, grants: [] };
  for (const c of cosmetics) {
    const slot = _slotOf(c);
    out.grants.push({
      id: String(c._id), slot, assetKey: c.assetKey,
      renderType: c.renderType || "png", animationUrl: c.animationUrl || null,
    });
    if (slot === "table_theme" && !out.tableTheme) {
      out.tableTheme = c.assetKey;
      out.tableAsset = c.promoMeta?.tableAsset || null;
    }
    if (slot === "card_back" && !out.cardSkin) {
      out.cardSkin = c.assetKey;
      out.cardAssets = Array.isArray(c.promoMeta?.cardAssets) ? c.promoMeta.cardAssets : null;
    }
  }
  if (fallback) {
    if (!out.tableTheme) { out.tableTheme = fallback.tableTheme || null; out.tableAsset = out.tableAsset || fallback.tableAsset || null; }
    if (!out.tableAsset) out.tableAsset = fallback.tableAsset || null;
    if (!out.cardSkin) { out.cardSkin = fallback.cardSkin || null; out.cardAssets = out.cardAssets || fallback.cardAssets || null; }
    if (!out.cardAssets) out.cardAssets = fallback.cardAssets || null;
  }
  return out;
}

function _ensureWarm() {
  if (_warm || _refreshing) return;
  _refreshing = true;
  refresh()
    .catch((e) => logger.warn("vip_reward_registry_warm_failed", { reason: e?.message || "unknown" }))
    .finally(() => { _refreshing = false; });
}

/** Reload rewards from the DB, overlaying the legacy seed. */
async function refresh() {
  const VipReward = require("../models/vipRewardModel");
  const Cosmetic = require("../models/cosmeticModel");
  const rewards = await VipReward.find({ enabled: true }).lean();
  const map = _seed();
  if (rewards.length > 0) {
    const ids = [...new Set(rewards.map((r) => String(r.cosmeticId)))];
    const cosmetics = await Cosmetic.find({ _id: { $in: ids }, isActive: true }).lean();
    const byId = new Map(cosmetics.map((c) => [String(c._id), c]));
    const byLevel = new Map();
    for (const r of rewards) {
      const c = byId.get(String(r.cosmeticId));
      if (!c) continue;
      if (!byLevel.has(r.vipLevelKey)) byLevel.set(r.vipLevelKey, []);
      byLevel.get(r.vipLevelKey).push(c);
    }
    for (const [level, list] of byLevel) map.set(level, _project(list, map.get(level)));
  }
  _byLevel = map;
  _warm = true;
  return map;
}

/** Sync accessor — same shape as the legacy config.vipCosmeticsForLevel. */
function vipCosmeticsForLevel(level) {
  _ensureWarm();
  return _byLevel.get(String(level || "").toLowerCase().trim()) || null;
}

/** VIP always overrides store table/card themes while active; skin stays store-equipped. */
function resolveEffectiveSeatCosmetics({ equipped, vipLevel }) {
  const eq = equipped && typeof equipped === "object" ? equipped : {};
  const vip = vipCosmeticsForLevel(vipLevel);
  return {
    skin: eq.skin || eq.avatarFrame || null,
    tableTheme: vip?.tableTheme || eq.tableTheme || null,
    cardSkin: vip?.cardSkin || eq.cardSkin || null,
    tableAsset: vip?.tableAsset || null,
    cardAssets: vip?.cardAssets || null,
  };
}

function _resetForTests() {
  _byLevel = _seed();
  _warm = false;
  _refreshing = false;
}

module.exports = {
  LEGACY_VIP_COSMETICS,
  vipCosmeticsForLevel,
  resolveEffectiveSeatCosmetics,
  refresh,
  _resetForTests,
};
