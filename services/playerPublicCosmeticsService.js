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
const { vipCosmeticsForLevel } = require("../config/vipCosmeticsConfig");
const { resolveTableFelt } = require("./vipEntitlementService");

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
  // The player's own choice comes first. This used to read
  // `vip?.cardSkin || eq.cardSkin`, so a subscriber wore their tier's back no
  // matter what they equipped and had no way to turn it off or swap it. VIP
  // still supplies the default when they have chosen nothing.
  const cardSkin = eq.cardSkin || vip?.cardSkin || null;
  return {
    skin: eq.skin || eq.avatarFrame || null,
    avatarFrame: eq.skin || eq.avatarFrame || null,
    cardSkin,
    // The raster pair belongs to the VIP back specifically. Sending it beside a
    // store back would paint VIP cards over the skin the player picked.
    cardAssets: cardSkin && cardSkin === vip?.cardSkin ? vip.cardAssets || null : null,
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
 * The felt everyone at this table sees.
 *
 * One table, one felt, so somebody has to win. The order is:
 *
 *   1. The highest seated VIP. That is a paid perk and stays on top.
 *   2. Otherwise the lowest-seated player who has a table theme equipped.
 *
 * Rule 2 is new. This function used to receive `{ vipLevel }` and nothing else,
 * so a theme a player had bought and equipped could not reach the felt even in
 * principle — the store sold table themes that changed nothing. Picking by seat
 * index rather than, say, whoever joined last keeps the answer stable: the same
 * players in the same seats always produce the same felt, instead of it
 * flickering as unrelated state moves around.
 *
 * @param {Array<{ vipLevel?: string|null, equippedTableTheme?: string|null,
 *                 seatIndex?: number }>} seatedHumans
 */
function resolveActiveTableCosmetics(seatedHumans) {
  // The rule itself is pure and tested in vipEntitlementService: the highest
  // seated VIP decides, using their equipped theme when they have one so they
  // can change the felt mid-game, else their tier felt; with no VIP seated it
  // falls to the lowest-seated equipped theme, which is stable across calls.
  return resolveTableFelt(seatedHumans, vipCosmeticsForLevel);
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
  for (const [index, s] of (seats || []).entries()) {
    if (!s || s.isBot || !s.userId) continue;
    if (toSafeChips(s.chips) <= 0) continue;
    const uid = String(s.userId);
    // `equippedMap` was already being fetched and its tableTheme thrown away
    // here, which is the whole reason bought table themes did nothing.
    // `s.seatIndex` when the caller supplies one, else position in the array.
    seatedForTable.push({
      vipLevel: vipMap.get(uid) || null,
      equippedTableTheme: equippedMap.get(uid)?.tableTheme || null,
      seatIndex: Number.isFinite(s.seatIndex) ? s.seatIndex : index,
    });
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

/**
 * Trix / Tarneeb: profile skin per seat, plus the table-wide felt.
 *
 * Same felt rule as poker — see `resolveActiveTableCosmetics`. Card backs are
 * deliberately absent: Trix renders no face-down cards at all, and keeping the
 * two games on one resolver means the felt cannot drift between them.
 *
 * @returns {Promise<{ byUserId: Map<string, object>, activeTableTheme: string|null }>}
 */
async function resolveCardGameCosmeticsForSeats(seats) {
  const humanIds = humanIdsFromSeats(seats);
  const byUserId = new Map();
  if (humanIds.length === 0) {
    return { byUserId, activeTableTheme: null };
  }

  const [equippedMap, vipMap] = await Promise.all([
    cosmeticsService.resolveEquippedPayloadForUsers(humanIds),
    vipService.getVipLevelsForUsers(humanIds),
  ]);

  const seatedForTable = [];
  for (const [index, s] of (seats || []).entries()) {
    if (!s || s.isBot || !s.userId) continue;
    const uid = String(s.userId);
    seatedForTable.push({
      vipLevel: vipMap.get(uid) || null,
      equippedTableTheme: equippedMap.get(uid)?.tableTheme || null,
      seatIndex: Number.isFinite(s.seatIndex) ? s.seatIndex : index,
    });
  }

  for (const uid of humanIds) {
    byUserId.set(uid, {
      vipLevel: vipMap.get(uid) || null,
      cosmetics: resolveProfileOnlyCosmetics({
        equipped: equippedMap.get(uid) || {},
      }),
    });
  }

  const { activeTableTheme } = resolveActiveTableCosmetics(seatedForTable);
  return { byUserId, activeTableTheme };
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
  resolveCardGameCosmeticsForSeats,
  publicCosmeticsPayload,
  publicSeatCosmeticsPayload,
  vipCosmeticsForLevel,
};
