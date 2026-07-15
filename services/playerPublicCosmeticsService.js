"use strict";

/**
 * Resolve public seat cosmetics: store skin + VIP table/card overrides.
 */
const cosmeticsService = require("./cosmeticsService");
const vipService = require("./vipService");
const {
  resolveEffectiveSeatCosmetics,
  vipCosmeticsForLevel,
} = require("../config/vipCosmeticsConfig");

function emptyCosmetics() {
  return {
    skin: null,
    avatarFrame: null,
    tableTheme: null,
    cardSkin: null,
    tableAsset: null,
    cardAssets: null,
  };
}

/**
 * @param {Array<{userId?: string|null, isBot?: boolean}>} seats
 * @returns {Promise<Map<string, object>>} userId -> effective cosmetics + vipLevel
 */
async function resolvePublicCosmeticsForSeats(seats) {
  const humanIds = [
    ...new Set(
      (seats || [])
        .filter((s) => s && s.userId && !s.isBot)
        .map((s) => String(s.userId))
    ),
  ];
  const out = new Map();
  if (humanIds.length === 0) return out;

  const [equippedMap, vipMap] = await Promise.all([
    cosmeticsService.resolveEquippedPayloadForUsers(humanIds),
    vipService.getVipLevelsForUsers(humanIds),
  ]);

  for (const uid of humanIds) {
    const vipLevel = vipMap.get(uid) || null;
    const equipped = equippedMap.get(uid) || {};
    const effective = resolveEffectiveSeatCosmetics({ equipped, vipLevel });
    out.set(uid, {
      vipLevel,
      cosmetics: {
        skin: effective.skin,
        avatarFrame: effective.skin,
        tableTheme: effective.tableTheme,
        cardSkin: effective.cardSkin,
        tableAsset: effective.tableAsset,
        cardAssets: effective.cardAssets,
      },
    });
  }
  return out;
}

function publicCosmeticsPayload(cosmetics) {
  const c = cosmetics && typeof cosmetics === "object" ? cosmetics : {};
  return {
    skin: c.skin || c.avatarFrame || null,
    avatarFrame: c.skin || c.avatarFrame || null,
    tableTheme: c.tableTheme || null,
    cardSkin: c.cardSkin || null,
    tableAsset: c.tableAsset || null,
    cardAssets: Array.isArray(c.cardAssets) ? c.cardAssets : null,
  };
}

module.exports = {
  emptyCosmetics,
  resolvePublicCosmeticsForSeats,
  publicCosmeticsPayload,
  vipCosmeticsForLevel,
};
