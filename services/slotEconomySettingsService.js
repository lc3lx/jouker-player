"use strict";

/**
 * Live slot economy settings (Poseidon / Zeus / Zenobia).
 *
 * Spins read settings synchronously from memory. Every instance re-reads the
 * documents every few seconds, and a profile switch carries an `effectiveAt`
 * in the near future, so all instances change odds at the same moment without
 * any cross-instance messaging. An instance that has lost contact with the
 * database for too long refuses bonus purchases (it might quote a stale price)
 * but keeps serving spins.
 *
 * Settings never change odds directly — they select an immutable calibrated
 * profile from games/slotProfiles. There is deliberately no per-player,
 * per-bet-size or streak knob: one global, disclosed RTP per game.
 */

const registry = require("../games/slotProfiles/registry");

const POLL_MS = 5 * 1000;
const STALE_AFTER_MS = 25 * 1000;
const SWITCH_DELAY_MS = 30 * 1000;
const PROFILE_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const BET_FLOOR = 10000;
const BET_CEILING = 1000000000;

const DEFAULTS = Object.freeze({
  economyLive: false,
  activeProfileId: null,
  pending: { profileId: null, effectiveAt: null },
  profileChangedAt: null,
  enabled: true,
  buyEnabled: true,
  superBuyEnabled: true,
  minBet: BET_FLOOR,
  maxBet: BET_CEILING,
  revision: 0,
  updatedBy: null,
  updatedAt: null,
});

const state = new Map();
let lastSyncAt = 0;
let pollTimer = null;

function settingsError(message, statusCode, code) {
  const ApiError = require("../utils/apiError");
  return new ApiError(message, statusCode, { code });
}

function useMongo() {
  const mode = process.env.SLOT_ECONOMY_SETTINGS_MODE || (process.env.NODE_ENV === "test" ? "memory" : "mongo");
  return mode === "mongo";
}

function reset() {
  for (const game of registry.GAMES) state.set(game, { ...structuredClone(DEFAULTS), game });
  lastSyncAt = 0;
}
reset();

function toPlain(doc) {
  const plain = doc.toObject ? doc.toObject() : doc;
  return {
    ...structuredClone(DEFAULTS),
    game: plain.game,
    economyLive: !!plain.economyLive,
    activeProfileId: plain.activeProfileId || null,
    pending: {
      profileId: plain.pending?.profileId || null,
      effectiveAt: plain.pending?.effectiveAt ? new Date(plain.pending.effectiveAt) : null,
    },
    profileChangedAt: plain.profileChangedAt ? new Date(plain.profileChangedAt) : null,
    enabled: plain.enabled !== false,
    buyEnabled: plain.buyEnabled !== false,
    superBuyEnabled: plain.superBuyEnabled !== false,
    minBet: Number(plain.minBet) || BET_FLOOR,
    maxBet: Number(plain.maxBet) || BET_CEILING,
    revision: Number(plain.revision) || 0,
    updatedBy: plain.updatedBy ? String(plain.updatedBy) : null,
    updatedAt: plain.updatedAt ? new Date(plain.updatedAt) : null,
  };
}

function applyDoc(doc) {
  if (!doc || !registry.GAMES.includes(doc.game)) return;
  const next = toPlain(doc);
  const current = state.get(next.game);
  if (!current || next.revision >= current.revision) state.set(next.game, next);
}

function assertGame(game) {
  if (!registry.GAMES.includes(game)) throw settingsError(`Unknown slot game: ${game}`, 404, "unknown_game");
}

/** Snapshot of a game's settings (safe to mutate). */
function getSettings(game) {
  assertGame(game);
  return structuredClone(state.get(game));
}

/** The profile id spins should use right now (pending switch included). */
function activeProfileId(game, now = Date.now()) {
  const s = state.get(game);
  if (s.pending?.profileId && s.pending.effectiveAt && s.pending.effectiveAt.getTime() <= now) {
    return s.pending.profileId;
  }
  return s.activeProfileId || registry.defaultProfileId(game);
}

function activeProfile(game, now = Date.now()) {
  const id = activeProfileId(game, now);
  if (!id) throw settingsError("No economy profile is available for this game", 503, "no_profile");
  return registry.getProfile(id);
}

function isEconomyLive(game) {
  assertGame(game);
  return state.get(game).economyLive === true;
}

/** True when this instance may be quoting outdated prices. */
function isStale(now = Date.now()) {
  if (!useMongo()) return false;
  return lastSyncAt === 0 || now - lastSyncAt > STALE_AFTER_MS;
}

async function loadFromDb() {
  if (!useMongo()) return;
  const Model = require("../models/slotEconomySettingsModel");
  const docs = await Model.find({}).lean();
  for (const doc of docs) applyDoc(doc);
  lastSyncAt = Date.now();
}

function startPolling() {
  if (pollTimer || !useMongo()) return;
  pollTimer = setInterval(() => {
    loadFromDb().catch((err) => {
      require("../utils/logger").warn("slot_economy_settings_poll_failed", { reason: err?.message });
    });
  }, POLL_MS);
  pollTimer.unref?.();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// --- admin updates ---------------------------------------------------------------

const BOOL_KEYS = ["economyLive", "enabled", "buyEnabled", "superBuyEnabled"];

function validatePatch(game, patch) {
  const allowed = new Set([...BOOL_KEYS, "profileId", "minBet", "maxBet"]);
  const unknown = Object.keys(patch).filter((k) => !allowed.has(k));
  if (unknown.length) throw settingsError(`Unknown setting: ${unknown.join(", ")}`, 400, "invalid_setting");
  for (const key of BOOL_KEYS) {
    if (key in patch && typeof patch[key] !== "boolean") throw settingsError(`${key} must be true or false`, 400, "invalid_setting");
  }
  for (const key of ["minBet", "maxBet"]) {
    if (key in patch && (!Number.isInteger(patch[key]) || patch[key] < BET_FLOOR || patch[key] > BET_CEILING)) {
      throw settingsError(`${key} must be a whole number between ${BET_FLOOR} and ${BET_CEILING}`, 400, "invalid_setting");
    }
  }
  if ("profileId" in patch) {
    const id = patch.profileId;
    if (typeof id !== "string" || !registry.hasProfile(id)) throw settingsError("Unknown economy profile", 400, "unknown_profile");
    const profile = registry.getProfile(id);
    if (profile.game !== game) throw settingsError("That profile belongs to another game", 400, "wrong_game");
    if (profile.status !== "active") throw settingsError("That profile is retired", 400, "retired_profile");
    if (!registry.isVerified(id)) throw settingsError("That profile failed verification against the current engine", 409, "profile_unverified");
  }
}

/**
 * Apply an admin change. `patch` may contain economyLive, profileId, enabled,
 * buyEnabled, superBuyEnabled, minBet, maxBet. Returns { before, after }.
 */
async function updateSettings(game, patch, { actorId = null, reason, expectedRevision, now = Date.now() } = {}) {
  assertGame(game);
  if (typeof reason !== "string" || reason.trim().length < 3) {
    throw settingsError("A reason is required for every economy change", 400, "reason_required");
  }
  validatePatch(game, patch);
  if (useMongo()) await loadFromDb();
  const before = getSettings(game);
  if (expectedRevision !== undefined && expectedRevision !== before.revision) {
    throw settingsError("These settings were changed by someone else — reload and try again", 409, "revision_conflict");
  }

  const next = structuredClone(before);
  // A switch whose moment has passed is simply the active profile now.
  if (next.pending.profileId && next.pending.effectiveAt && next.pending.effectiveAt.getTime() <= now) {
    next.activeProfileId = next.pending.profileId;
    next.pending = { profileId: null, effectiveAt: null };
  }
  for (const key of [...BOOL_KEYS, "minBet", "maxBet"]) if (key in patch) next[key] = patch[key];
  if (next.minBet > next.maxBet) throw settingsError("minBet cannot exceed maxBet", 400, "invalid_setting");

  const currentProfile = next.activeProfileId || registry.defaultProfileId(game);
  if ("profileId" in patch && patch.profileId !== currentProfile) {
    if (next.pending.profileId) throw settingsError("A profile switch is already scheduled", 409, "switch_in_progress");
    const lastChange = before.profileChangedAt?.getTime() || 0;
    if (before.economyLive && now - lastChange < PROFILE_CHANGE_COOLDOWN_MS) {
      throw settingsError("The RTP profile can change at most once every 24 hours", 409, "profile_cooldown");
    }
    if (next.economyLive) {
      next.pending = { profileId: patch.profileId, effectiveAt: new Date(now + SWITCH_DELAY_MS) };
    } else {
      // Not live yet: nobody plays this profile, so it applies immediately.
      next.activeProfileId = patch.profileId;
    }
    next.profileChangedAt = new Date(now);
  }
  if (next.economyLive && !before.economyLive) {
    const id = next.pending.profileId || next.activeProfileId || registry.defaultProfileId(game);
    if (!id || !registry.isVerified(id)) {
      throw settingsError("Cannot go live without a verified economy profile", 409, "profile_unverified");
    }
    next.activeProfileId = next.activeProfileId || id;
  }
  next.revision = before.revision + 1;
  next.updatedBy = actorId ? String(actorId) : null;
  next.updatedAt = new Date(now);

  if (useMongo()) {
    const Model = require("../models/slotEconomySettingsModel");
    const doc = {
      economyLive: next.economyLive,
      activeProfileId: next.activeProfileId,
      pending: next.pending,
      profileChangedAt: next.profileChangedAt,
      enabled: next.enabled,
      buyEnabled: next.buyEnabled,
      superBuyEnabled: next.superBuyEnabled,
      minBet: next.minBet,
      maxBet: next.maxBet,
      revision: next.revision,
      updatedBy: actorId || null,
    };
    try {
      const saved = await Model.findOneAndUpdate(
        { game, revision: before.revision },
        { $set: doc },
        { upsert: before.revision === 0, new: true },
      ).lean();
      if (!saved) throw settingsError("These settings were changed by someone else — reload and try again", 409, "revision_conflict");
      applyDoc(saved);
    } catch (err) {
      if (err?.code === 11000) throw settingsError("These settings were changed by someone else — reload and try again", 409, "revision_conflict");
      throw err;
    }
  } else {
    state.set(game, next);
  }
  try {
    require("./economyBroadcast").broadcast("slot_economy_updated", { game, revision: next.revision });
  } catch (_) {
    /* clients also refetch on resume and on a 409 */
  }
  return { before, after: getSettings(game) };
}

module.exports = {
  POLL_MS,
  STALE_AFTER_MS,
  SWITCH_DELAY_MS,
  PROFILE_CHANGE_COOLDOWN_MS,
  getSettings,
  activeProfileId,
  activeProfile,
  isEconomyLive,
  isStale,
  loadFromDb,
  startPolling,
  stopPolling,
  updateSettings,
  _resetForTests: reset,
};
