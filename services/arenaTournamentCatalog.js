"use strict";

const GAMES = ["poker", "trix", "tarneeb41"];

const GAME_LABEL_AR = {
  poker: "بوكر",
  trix: "تركس",
  tarneeb41: "طرنيب",
};

/**
 * House catalog. Length is a round count (4 / 8 / 12 games), not a clock.
 * `durationMinutes` is kept on the document as the round target (legacy field).
 * House events fire on a 2-hour grid. Prize numbers shown in the lobby are
 * the full-field pool (entryFee × maxPlayers); the live prizePool is the
 * escrow actually collected.
 */
const TIERS = [
  {
    id: "mini",
    nameAr: "صغيرة",
    nameEn: "Mini",
    durationMinutes: 4,
    maxPlayers: 8,
    minPlayers: 4,
    entryFee: 250,
    startingChips: 2000,
    guaranteedPrize: 2000,
  },
  {
    id: "small",
    nameAr: "أكبر بشوي",
    nameEn: "A bit bigger",
    durationMinutes: 4,
    maxPlayers: 12,
    minPlayers: 4,
    entryFee: 1000,
    startingChips: 3500,
    guaranteedPrize: 12000,
  },
  {
    id: "medium",
    nameAr: "أكبر",
    nameEn: "Bigger",
    durationMinutes: 8,
    maxPlayers: 16,
    minPlayers: 8,
    entryFee: 4000,
    startingChips: 6000,
    guaranteedPrize: 64000,
  },
  {
    id: "large",
    nameAr: "أكبر بكثير",
    nameEn: "Much bigger",
    durationMinutes: 8,
    maxPlayers: 24,
    minPlayers: 8,
    entryFee: 12000,
    startingChips: 10000,
    guaranteedPrize: 288000,
  },
  {
    id: "pro",
    nameAr: "الأكبر",
    nameEn: "Biggest",
    durationMinutes: 12,
    maxPlayers: 32,
    minPlayers: 8,
    entryFee: 40000,
    startingChips: 20000,
    guaranteedPrize: 1280000,
  },
];

const CREATE_FEE = 5_000_000;
const SLOT_MS = 2 * 60 * 60 * 1000;
const DURATIONS = [4, 8, 12];
const ROUND_SAFETY_MS = 6 * 60 * 60 * 1000;

/** Live admin overrides: { [tierId]: { nameAr?, entryFee? } } */
let _overrides = {};

function applyOverrides(overrides) {
  _overrides = overrides && typeof overrides === "object" ? overrides : {};
}

function overridesFromSettings(doc) {
  const map = {};
  for (const row of doc?.tiers || []) {
    if (!row?.id) continue;
    map[row.id] = {
      ...(row.nameAr ? { nameAr: String(row.nameAr).trim() } : {}),
      ...(Number.isFinite(Number(row.entryFee)) ? { entryFee: Math.max(0, Math.trunc(Number(row.entryFee))) } : {}),
    };
  }
  return map;
}

function resolvedTiers() {
  return TIERS.map((t) => {
    const over = _overrides[t.id] || {};
    const entryFee = Number.isFinite(Number(over.entryFee)) ? Math.max(0, Math.trunc(over.entryFee)) : t.entryFee;
    return {
      ...t,
      nameAr: over.nameAr && String(over.nameAr).trim() ? String(over.nameAr).trim() : t.nameAr,
      entryFee,
      guaranteedPrize: entryFee * t.maxPlayers,
    };
  });
}

function getTier(id) {
  return resolvedTiers().find((t) => t.id === id) || null;
}

async function loadFromDb() {
  const ArenaTournamentSettings = require("../models/arenaTournamentSettingsModel");
  const doc = await ArenaTournamentSettings.getDefaults();
  applyOverrides(overridesFromSettings(doc));
  return resolvedTiers();
}

function nextSlotStart(fromMs = Date.now()) {
  return Math.ceil((fromMs + 1) / SLOT_MS) * SLOT_MS;
}

function slotKey(game, tierId, slotStartMs) {
  return `house:${game}:${tierId}:${slotStartMs}`;
}

function roundsOf(tierOrDoc) {
  const n = Number(tierOrDoc?.rounds ?? tierOrDoc?.durationMinutes) || 4;
  return DURATIONS.includes(n) ? n : 4;
}

function houseName(game, tier) {
  return `${GAME_LABEL_AR[game] || game} · ${tier.nameAr} · ${roundsOf(tier)} جولات`;
}

function defaultPrizeDistribution(playerCount) {
  if (playerCount <= 2) return [{ place: 1, percent: 100 }];
  if (playerCount <= 4) return [{ place: 1, percent: 70 }, { place: 2, percent: 30 }];
  if (playerCount <= 8) {
    return [
      { place: 1, percent: 60 },
      { place: 2, percent: 25 },
      { place: 3, percent: 15 },
    ];
  }
  return [
    { place: 1, percent: 50 },
    { place: 2, percent: 25 },
    { place: 3, percent: 15 },
    { place: 4, percent: 10 },
  ];
}

function serializeCatalog() {
  return {
    createFee: CREATE_FEE,
    slotMs: SLOT_MS,
    durations: DURATIONS,
    rounds: DURATIONS,
    games: GAMES.map((id) => ({ id, nameAr: GAME_LABEL_AR[id] })),
    tiers: resolvedTiers().map((t) => ({
      ...t,
      rounds: t.durationMinutes,
      prizeHint: t.entryFee * t.maxPlayers,
    })),
  };
}

module.exports = {
  GAMES,
  GAME_LABEL_AR,
  TIERS,
  CREATE_FEE,
  SLOT_MS,
  DURATIONS,
  ROUND_SAFETY_MS,
  getTier,
  resolvedTiers,
  applyOverrides,
  overridesFromSettings,
  loadFromDb,
  nextSlotStart,
  slotKey,
  roundsOf,
  houseName,
  defaultPrizeDistribution,
  serializeCatalog,
};
