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
  let bestLevel = null;
  let bestRank = 0;
  let equippedTheme = null;
  let equippedSeat = Infinity;

  for (const row of seatedHumans || []) {
    const lvl = row?.vipLevel || null;
    if (lvl) {
      const rank = vipLevelRank(lvl);
      if (rank > bestRank) {
        bestRank = rank;
        bestLevel = lvl;
      }
    }

    const theme = row?.equippedTableTheme || null;
    if (theme) {
      const seat = Number.isFinite(row?.seatIndex) ? row.seatIndex : Infinity;
      if (seat < equippedSeat) {
        equippedSeat = seat;
        equippedTheme = theme;
      }
    }
  }

  if (bestLevel) {
    const vip = vipCosmeticsForLevel(bestLevel);
    if (vip?.tableTheme) {
      return {
        activeTableTheme: vip.tableTheme,
        activeTableAsset: vip.tableAsset || null,
      };
    }
  }

  // A bought theme is a gradient key, not a sprite, so there is no asset path
  // to go with it — the client renders it from the key alone.
  if (equippedTheme) {
    return { activeTableTheme: equippedTheme, activeTableAsset: null };
  }

  return { activeTableTheme: null, activeTableAsset: null };
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
