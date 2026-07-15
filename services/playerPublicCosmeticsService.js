"use strict";

/**
 * Public seat cosmetics — server is the single source of truth.
 *
 * Poker:
 *  - Table felt: one active VIP theme for the whole table (highest seated VIP).
 *  - Per seat: profile skin + owner card backs only.
 *
 * Trix / Tarneeb:
 *  - Profile skin (+ vipLevel badge) only — no table or card cosmetics.
 */
const cosmeticsService = require("./cosmeticsService");
const vipService = require("./vipService");
const { vipLevelRank } = require("../config/vipConfig");
const { vipCosmeticsForLevel } = require("../config/vipCosmeticsConfig");

function emptySeatCosmetics() {
  return {
    skin: null,
    avatarFrame: null,
    cardSkin: null,
    cardAssets: null,
  };
}

/** @deprecated alias — seat payload only (no table fields). */
function emptyCosmetics() {
  return emptySeatCosmetics();
}

function resolveSeatCardCosmetics({ equipped, vipLevel }) {
  const eq = equipped && typeof equipped === "object" ? equipped : {};
  const vip = vipCosmeticsForLevel(vipLevel);
  return {
    skin: eq.skin || eq.avatarFrame || null,
    avatarFrame: eq.skin || eq.avatarFrame || null,
    cardSkin: vip?.cardSkin || eq.cardSkin || null,
    cardAssets: vip?.cardAssets || null,
  };
}

function resolveProfileOnlyCosmetics({ equipped }) {
  const eq = equipped && typeof equipped === "object" ? equipped : {};
  return {
    skin: eq.skin || eq.avatarFrame || null,
    avatarFrame: eq.skin || eq.avatarFrame || null,
  };
}

/**
 * Pick the highest VIP among seated humans (chips > 0) for shared table felt.
 * @param {Array<{ vipLevel?: string|null }>} seatedHumans
 */
function resolveActiveTableCosmetics(seatedHumans) {
  let bestLevel = null;
  let bestRank = 0;
  for (const row of seatedHumans || []) {
    const lvl = row?.vipLevel || null;
    if (!lvl) continue;
    const rank = vipLevelRank(lvl);
    if (rank > bestRank) {
      bestRank = rank;
      bestLevel = lvl;
    }
  }
  if (!bestLevel) {
    return { activeTableTheme: null, activeTableAsset: null };
  }
  const vip = vipCosmeticsForLevel(bestLevel);
  return {
    activeTableTheme: vip?.tableTheme || null,
    activeTableAsset: vip?.tableAsset || null,
  };
}

function humanIdsFromSeats(seats) {
  return [
    ...new Set(
      (seats || [])
        .filter((s) => s && s.userId && !s.isBot)
        .map((s) => String(s.userId))
    ),
  ];
}

/**
 * Poker table: per-seat skin + card backs, plus table-wide active VIP felt.
 * @returns {Promise<{ byUserId: Map<string, object>, activeTableTheme: string|null, activeTableAsset: string|null }>}
 */
async function resolvePublicCosmeticsForPokerSeats(seats) {
  const humanIds = humanIdsFromSeats(seats);
  const byUserId = new Map();
  if (humanIds.length === 0) {
    return {
      byUserId,
      activeTableTheme: null,
      activeTableAsset: null,
    };
  }

  const [equippedMap, vipMap] = await Promise.all([
    cosmeticsService.resolveEquippedPayloadForUsers(humanIds),
    vipService.getVipLevelsForUsers(humanIds),
  ]);

  const seatedForTable = [];
  for (const s of seats || []) {
    if (!s || s.isBot || !s.userId) continue;
    if (toSafeChips(s.chips) <= 0) continue;
    const uid = String(s.userId);
    const vipLevel = vipMap.get(uid) || null;
    seatedForTable.push({ vipLevel });
  }

  for (const uid of humanIds) {
    const vipLevel = vipMap.get(uid) || null;
    const equipped = equippedMap.get(uid) || {};
    const cosmetics = resolveSeatCardCosmetics({ equipped, vipLevel });
    byUserId.set(uid, { vipLevel, cosmetics });
  }

  const { activeTableTheme, activeTableAsset } =
    resolveActiveTableCosmetics(seatedForTable);

  return { byUserId, activeTableTheme, activeTableAsset };
}

/**
 * Trix / Tarneeb: profile skin only.
 * @returns {Promise<Map<string, object>>}
 */
async function resolveProfileOnlyCosmeticsForSeats(seats) {
  const humanIds = humanIdsFromSeats(seats);
  const out = new Map();
  if (humanIds.length === 0) return out;

  const [equippedMap, vipMap] = await Promise.all([
    cosmeticsService.resolveEquippedPayloadForUsers(humanIds),
    vipService.getVipLevelsForUsers(humanIds),
  ]);

  for (const uid of humanIds) {
    const vipLevel = vipMap.get(uid) || null;
    const equipped = equippedMap.get(uid) || {};
    const cosmetics = resolveProfileOnlyCosmetics({ equipped, vipLevel });
    out.set(uid, { vipLevel, cosmetics });
  }
  return out;
}

/** Backward-compatible alias for poker resolvers. */
async function resolvePublicCosmeticsForSeats(seats) {
  const { byUserId } = await resolvePublicCosmeticsForPokerSeats(seats);
  return byUserId;
}

function publicSeatCosmeticsPayload(cosmetics) {
  const c = cosmetics && typeof cosmetics === "object" ? cosmetics : {};
  return {
    skin: c.skin || c.avatarFrame || null,
    avatarFrame: c.skin || c.avatarFrame || null,
    cardSkin: c.cardSkin || null,
    cardAssets: Array.isArray(c.cardAssets) ? c.cardAssets : null,
  };
}

function publicCosmeticsPayload(cosmetics) {
  return publicSeatCosmeticsPayload(cosmetics);
}

function toSafeChips(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

module.exports = {
  emptyCosmetics,
  emptySeatCosmetics,
  resolveSeatCardCosmetics,
  resolveProfileOnlyCosmetics,
  resolveActiveTableCosmetics,
  resolvePublicCosmeticsForSeats,
  resolvePublicCosmeticsForPokerSeats,
  resolveProfileOnlyCosmeticsForSeats,
  publicCosmeticsPayload,
  publicSeatCosmeticsPayload,
  vipCosmeticsForLevel,
};
