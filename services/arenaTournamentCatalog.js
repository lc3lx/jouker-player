"use strict";

const GAMES = ["poker", "trix", "tarneeb41"];

const GAME_LABEL_AR = {
  poker: "بوكر",
  trix: "تركس",
  tarneeb41: "طرنيب",
};

/**
 * House catalog. Durations are consecutive play minutes after kickoff.
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
    nameEn: "Small+",
    durationMinutes: 4,
    maxPlayers: 12,
    minPlayers: 4,
    entryFee: 1000,
    startingChips: 3500,
    guaranteedPrize: 12000,
  },
  {
    id: "medium",
    nameAr: "متوسطة",
    nameEn: "Medium",
    durationMinutes: 8,
    maxPlayers: 16,
    minPlayers: 8,
    entryFee: 4000,
    startingChips: 6000,
    guaranteedPrize: 64000,
  },
  {
    id: "large",
    nameAr: "كبيرة",
    nameEn: "Large",
    durationMinutes: 8,
    maxPlayers: 24,
    minPlayers: 8,
    entryFee: 12000,
    startingChips: 10000,
    guaranteedPrize: 288000,
  },
  {
    id: "pro",
    nameAr: "احترافية",
    nameEn: "Championship",
    durationMinutes: 12,
    maxPlayers: 32,
    minPlayers: 8,
    entryFee: 40000,
    startingChips: 20000,
    guaranteedPrize: 1280000,
  },
];

const CREATE_FEE = 2000;
const SLOT_MS = 2 * 60 * 60 * 1000;
const DURATIONS = [4, 8, 12];

function getTier(id) {
  return TIERS.find((t) => t.id === id) || null;
}

function nextSlotStart(fromMs = Date.now()) {
  return Math.ceil((fromMs + 1) / SLOT_MS) * SLOT_MS;
}

function slotKey(game, tierId, slotStartMs) {
  return `house:${game}:${tierId}:${slotStartMs}`;
}

function houseName(game, tier) {
  return `${GAME_LABEL_AR[game] || game} · ${tier.nameAr} · ${tier.durationMinutes} د`;
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
    games: GAMES.map((id) => ({ id, nameAr: GAME_LABEL_AR[id] })),
    tiers: TIERS.map((t) => ({
      ...t,
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
  getTier,
  nextSlotStart,
  slotKey,
  houseName,
  defaultPrizeDistribution,
  serializeCatalog,
};
