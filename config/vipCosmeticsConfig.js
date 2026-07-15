"use strict";

/**
 * VIP → table theme + face-down card backs only.
 * Profile skins are store-only and never granted by VIP.
 */

const VIP_COSMETICS = {
  bronze: {
    tableTheme: "vip_bronze",
    cardSkin: "vip_bronze",
    tableAsset: "vip/bronze/taple_vip_bronze.png",
    cardAssets: [
      "vip/bronze/cards1_vip_bronze.png",
      "vip/bronze/cards2_vip_bronze.png",
    ],
  },
  silver: {
    tableTheme: "vip_silver",
    cardSkin: "vip_silver",
    tableAsset: "vip/silver/taple_vip_silver.png",
    cardAssets: [
      "vip/silver/cards1_vip_silver.png",
      "vip/silver/cards2_vip_silver.png",
    ],
  },
  gold: {
    tableTheme: "vip_gold",
    cardSkin: "vip_gold",
    tableAsset: "vip/gold/taple_vip_golde.png",
    cardAssets: [
      "vip/gold/cards1_vip_golde.png",
      "vip/gold/cards2_vip_golde.png",
    ],
  },
  platinum: {
    tableTheme: "vip_platinum",
    cardSkin: "vip_platinum",
    tableAsset: "vip/platinum/taple_vip_platinum.png",
    cardAssets: [
      "vip/platinum/cards1_vip_platinum.png",
      "vip/platinum/cards2_vip_platinum.png",
    ],
  },
};

function vipCosmeticsForLevel(level) {
  const key = String(level || "")
    .toLowerCase()
    .trim();
  return VIP_COSMETICS[key] || null;
}

/**
 * VIP always overrides store table/card themes while active (option A).
 * Skin is always store-equipped only.
 */
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

module.exports = {
  VIP_COSMETICS,
  vipCosmeticsForLevel,
  resolveEffectiveSeatCosmetics,
};
