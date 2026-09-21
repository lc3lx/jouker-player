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
 * Prize numbers shown in the lobby are the full-field pool
 * (entryFee × maxPlayers); the live prizePool is the escrow actually collected.
 *
 * `id` is the wire value and is written onto every tournament document and into
 * the admin's per-tier overrides, so it never changes. The names are display
 * only — they were placeholders ("صغيرة", "أكبر بشوي", "أكبر بكثير") that read
 * as sizes rather than as events, with no sense of a ladder being climbed.
 *
 * `rank` exists so the ordering has one definition. It used to be re-declared
 * as a literal array in the lobby screen, which is a list that can silently
 * disagree with this one.
 */
const TIERS = [
  {
    id: "mini",
    rank: 1,
    nameAr: "كأس المبتدئين",
    nameEn: "Rookie Cup",
    durationMinutes: 4,
    maxPlayers: 8,
    minPlayers: 4,
    entryFee: 250,
    startingChips: 2000,
    guaranteedPrize: 2000,
  },
  {
    id: "small",
    rank: 2,
    nameAr: "كأس الصاعدين",
    nameEn: "Challenger Cup",
    durationMinutes: 4,
    maxPlayers: 12,
    minPlayers: 4,
    entryFee: 1000,
    startingChips: 3500,
    guaranteedPrize: 12000,
  },
  {
    id: "medium",
    rank: 3,
    nameAr: "كأس المحترفين",
    nameEn: "Pro Cup",
    durationMinutes: 8,
    maxPlayers: 16,
    minPlayers: 8,
    entryFee: 4000,
    startingChips: 6000,
    guaranteedPrize: 64000,
  },
  {
    id: "large",
    rank: 4,
    nameAr: "كأس النخبة",
    nameEn: "Elite Cup",
    durationMinutes: 8,
    maxPlayers: 24,
    minPlayers: 8,
    entryFee: 12000,
    startingChips: 10000,
    guaranteedPrize: 288000,
  },
  {
    id: "pro",
    rank: 5,
    nameAr: "كأس الأساطير",
    nameEn: "Legends Cup",
    durationMinutes: 12,
    maxPlayers: 32,
    minPlayers: 8,
    entryFee: 40000,
    startingChips: 20000,
    guaranteedPrize: 1280000,
  },
];

/**
 * The names these tiers used to carry.
 *
 * An admin who renamed a tier from the CMS gets an override row that wins over
 * the default forever, so a stale override would keep a retired placeholder on
 * screen. `scripts/retireLegacyArenaTierNames.js` clears exactly these.
 */
const LEGACY_TIER_NAMES_AR = ["صغيرة", "أكبر بشوي", "أكبر", "أكبر بكثير", "الأكبر"];

const CREATE_FEE = 5_000_000;

/**
 * The house schedule.
 *
 * Every tier of every game used to start on the same 2-hour boundary, so the
 * lobby was empty for two hours and then held fifteen simultaneous events —
 * no rhythm, and a player who missed the moment waited two hours for anything
 * at all.
 *
 * Now one tier starts every half hour, climbing the ladder. The cycle is three
 * hours because it is the shortest span that both fits the five rungs at
 * half-hour spacing *and* divides the day evenly: 24 / 3 = 8 identical cycles,
 * so a given cup always starts at the same clock times, every day. A 2.5-hour
 * cycle would fit the rungs exactly but 1440 / 150 = 9.6, so the times would
 * drift daily and no player could ever learn them.
 *
 * That leaves one spare rung, which goes to the entry tier — the busiest, the
 * cheapest to enter, and the one a new player most needs to find running. So
 * something starts every half hour with no dead air anywhere in the cycle.
 */
const CYCLE_MS = 3 * 60 * 60 * 1000;
const RUNG_MS = 30 * 60 * 1000;

const LADDER = [
  { tierId: "mini", offsetMs: 0 * RUNG_MS },
  { tierId: "small", offsetMs: 1 * RUNG_MS },
  { tierId: "medium", offsetMs: 2 * RUNG_MS },
  { tierId: "large", offsetMs: 3 * RUNG_MS },
  { tierId: "pro", offsetMs: 4 * RUNG_MS },
  { tierId: "mini", offsetMs: 5 * RUNG_MS },
];

/** Registration opens this many cycles ahead. */
const SCHEDULE_CYCLES = 2;

/** Legacy alias: the client reads `slotMs` from the serialized catalog. */
const SLOT_MS = CYCLE_MS;
const DURATIONS = [4, 8, 12];
const ROUND_SAFETY_MS = 6 * 60 * 60 * 1000;

/** First-hand big blind is this fraction of the table stake (10M → 1M). */
const POKER_OPENING_FRACTION = 10;
const POKER_BLIND_CAP_SHIFT = 20;

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

/** The top of the cycle containing `ms`, on the UTC epoch grid. */
function cycleStart(ms = Date.now()) {
  return Math.floor(ms / CYCLE_MS) * CYCLE_MS;
}

/**
 * Every start from now to `cycles` cycles ahead, in time order.
 *
 * Returns `[{ tierId, startMs }]` — a tier can appear twice per cycle (the
 * entry tier does), which is why this is a list of starts rather than a map
 * keyed by tier.
 */
function upcomingStarts(fromMs = Date.now(), cycles = SCHEDULE_CYCLES) {
  const out = [];
  const base = cycleStart(fromMs);
  const span = Math.max(1, Math.trunc(cycles));
  // Start one cycle back so a rung later in the current cycle is not missed.
  for (let c = 0; c <= span; c += 1) {
    const top = base + c * CYCLE_MS;
    for (const rung of LADDER) {
      const startMs = top + rung.offsetMs;
      if (startMs > fromMs) out.push({ tierId: rung.tierId, startMs });
    }
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out.filter((s) => s.startMs <= base + span * CYCLE_MS + CYCLE_MS);
}

/** The very next start, whatever tier it belongs to. */
function nextSlotStart(fromMs = Date.now()) {
  const next = upcomingStarts(fromMs, 1)[0];
  return next ? next.startMs : cycleStart(fromMs) + CYCLE_MS;
}

function slotKey(game, tierId, slotStartMs) {
  return `house:${game}:${tierId}:${slotStartMs}`;
}

function roundsOf(tierOrDoc) {
  const n = Number(tierOrDoc?.rounds ?? tierOrDoc?.durationMinutes) || 4;
  return DURATIONS.includes(n) ? n : 4;
}

function isPokerFreezeout(gameOrDoc) {
  const game = typeof gameOrDoc === "string" ? gameOrDoc : gameOrDoc?.game;
  return game === "poker";
}

/** Table scale for poker: paid entry, else requested chips. 10M table → 10M stack. */
function pokerTableStake({ entryFee = 0, startingChips = 0 } = {}) {
  const fee = Math.max(0, Math.floor(Number(entryFee) || 0));
  const chips = Math.max(0, Math.floor(Number(startingChips) || 0));
  return Math.max(fee, chips, 1000);
}

function pokerStartingChips(entryFeeOrOpts, maybeChips) {
  if (entryFeeOrOpts && typeof entryFeeOrOpts === "object") {
    return pokerTableStake(entryFeeOrOpts);
  }
  return pokerTableStake({ entryFee: entryFeeOrOpts, startingChips: maybeChips });
}

/** Opening big blind = 10% of the table stake, then doubles each hand. */
function pokerOpeningBet(startingChips) {
  return Math.max(100, Math.floor(pokerTableStake({ startingChips }) / POKER_OPENING_FRACTION));
}

function pokerBlindsForHand(startingChips, gamesCompleted = 0) {
  const opening = pokerOpeningBet(startingChips);
  const level = Math.max(0, Math.floor(Number(gamesCompleted) || 0));
  const shift = Math.min(level, POKER_BLIND_CAP_SHIFT);
  const bigBlind = opening * 2 ** shift;
  return {
    smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
    bigBlind,
    minimumBet: bigBlind,
    level: level + 1,
    openingBet: opening,
  };
}

/**
 * The title on the card — the cup first, then the game.
 *
 * It used to read "بوكر · أكبر · 8 جولات": three data fields joined by dots,
 * with the format repeated from the card body right below it. The cup is what
 * the player is entering, so the cup leads; the format stays where it already
 * was, in the card's own rows.
 */
function houseName(game, tier) {
  return `${tier.nameAr} · ${GAME_LABEL_AR[game] || game}`;
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
    cycleMs: CYCLE_MS,
    rungMs: RUNG_MS,
    // The client draws the cycle so a player can see the whole schedule at
    // once; sending it beats hardcoding the same ladder on both sides.
    ladder: LADDER.map((r) => ({ tierId: r.tierId, offsetMs: r.offsetMs })),
    durations: DURATIONS,
    rounds: DURATIONS,
    games: GAMES.map((id) => ({ id, nameAr: GAME_LABEL_AR[id] })),
    tiers: resolvedTiers().map((t) => ({
      ...t,
      rounds: t.durationMinutes,
      prizeHint: t.entryFee * t.maxPlayers,
    })),
    pokerOpeningFraction: POKER_OPENING_FRACTION,
    pokerMode: "freezeout",
  };
}

module.exports = {
  GAMES,
  GAME_LABEL_AR,
  TIERS,
  LEGACY_TIER_NAMES_AR,
  CREATE_FEE,
  SLOT_MS,
  CYCLE_MS,
  RUNG_MS,
  LADDER,
  SCHEDULE_CYCLES,
  DURATIONS,
  ROUND_SAFETY_MS,
  cycleStart,
  upcomingStarts,
  getTier,
  resolvedTiers,
  applyOverrides,
  overridesFromSettings,
  loadFromDb,
  nextSlotStart,
  slotKey,
  roundsOf,
  houseName,
  isPokerFreezeout,
  pokerTableStake,
  pokerStartingChips,
  pokerOpeningBet,
  pokerBlindsForHand,
  POKER_OPENING_FRACTION,
  defaultPrizeDistribution,
  serializeCatalog,
};
