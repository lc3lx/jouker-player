"use strict";

/**
 * Slot economy profile registry.
 *
 * A profile is an immutable, offline-calibrated JSON file that fully defines
 * one game's odds (games/slotProfiles/<game>/<id>.json, written by
 * tool/slotProfileCalibrate.js). Admins choose which profile is active; they
 * never edit odds directly. Profiles are never deleted — only marked
 * `retired` — because bonus sessions stay pinned to the profile they were sold
 * under and Zeus spins must remain replayable for fairness verification.
 *
 * Every profile carries a `digest` of a fixed set of seeded outcomes. verify()
 * recomputes it with the current engine code: a profile whose engine has since
 * changed behaviour can no longer be activated.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createOperationRng } = require("../utils/operationRng");

const GAMES = Object.freeze(["poseidon", "zeus", "zenobia"]);
const ENGINE_VERSIONS = Object.freeze({ poseidon: 4, zeus: 5, zenobia: 3 });
const DEFAULT_TARGET_RTP = 0.94;
const DIGEST_SPINS = 120;

const RULE_KEYS = [
  "maxWinX", "maxFreeSpins", "freeSpinsNatural", "freeSpinsBought",
  "retriggerAward", "triggerNaturalMin", "triggerRetriggerMin",
];

const profiles = new Map(); // id → frozen profile
const verified = new Map(); // id → { ok, reason }

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function assertProbabilityTable(values, table, label, { percent }) {
  if (!Array.isArray(table) || table.length !== values.length) {
    throw new Error(`${label}: expected ${values.length} entries`);
  }
  if (table.some((w) => !Number.isFinite(w) || w < 0)) throw new Error(`${label}: invalid weight`);
  const sum = table.reduce((a, b) => a + b, 0);
  if (percent && sum > 100 + 1e-9) throw new Error(`${label}: per-spin probabilities exceed 100%`);
  if (!percent && !(sum > 0)) throw new Error(`${label}: weights must not all be zero`);
}

function assertSymbolTable(table, label) {
  if (!Array.isArray(table) || table.length === 0) throw new Error(`${label}: empty`);
  for (const entry of table) {
    const weight = Array.isArray(entry) ? entry[1] : entry;
    if (!Number.isFinite(weight) || weight < 0) throw new Error(`${label}: invalid weight`);
  }
}

/** Throws with a precise message when a profile is malformed. */
function validateProfile(profile) {
  const where = `profile ${profile?.id || "?"}`;
  if (!profile || typeof profile.id !== "string") throw new Error(`${where}: missing id`);
  if (!GAMES.includes(profile.game)) throw new Error(`${where}: unknown game`);
  if (profile.economyVersion !== ENGINE_VERSIONS[profile.game]) throw new Error(`${where}: wrong economyVersion`);
  if (!(profile.targetRtp > 0.5 && profile.targetRtp < 1)) throw new Error(`${where}: targetRtp out of range`);
  if (!["active", "retired"].includes(profile.status)) throw new Error(`${where}: invalid status`);
  for (const key of RULE_KEYS) {
    if (!(Number(profile.rules?.[key]) > 0)) throw new Error(`${where}: rules.${key} missing`);
  }
  if (!(profile.buy?.standardCost > 0) || !(profile.buy?.superCost > 0)) throw new Error(`${where}: buy prices missing`);
  if (!(profile.buy.standardEv > 0) || !(profile.buy.superEv > 0)) throw new Error(`${where}: buy EVs missing`);
  if (profile.buy.standardEv >= profile.buy.standardCost || profile.buy.superEv >= profile.buy.superCost) {
    throw new Error(`${where}: a bonus buy would return more than it costs`);
  }
  const p = profile.params;
  if (!p) throw new Error(`${where}: params missing`);
  if (!(p.jackpot?.win >= 0 && p.jackpot.win < 0.01)) throw new Error(`${where}: jackpot.win out of range`);
  if (!(p.naturalBonusProbability >= 0 && p.naturalBonusProbability < 0.05)) {
    throw new Error(`${where}: naturalBonusProbability out of range`);
  }
  const percent = profile.game !== "zenobia";
  for (const mode of ["base", "bonus", "super"]) {
    assertProbabilityTable(p.plaques.values, p.plaques[mode], `${where}: plaques.${mode}`, { percent });
  }
  for (const mode of profile.game === "zenobia" ? ["base", "bonus", "super"] : ["base", "bonus"]) {
    assertSymbolTable(p.symbols[mode], `${where}: symbols.${mode}`);
  }
  if (!(profile.measured?.rtp > 0)) throw new Error(`${where}: measured block missing`);
  if (typeof profile.digest !== "string") throw new Error(`${where}: digest missing`);
  return true;
}

// --- outcome digest -----------------------------------------------------------

function digestOutcomes(profile, spins = DIGEST_SPINS) {
  const rows = [];
  for (const mode of ["base", "bonus", "super"]) {
    for (let i = 0; i < spins; i += 1) {
      const rng = createOperationRng(`profile-digest-${profile.id}-${mode}-${i}`);
      const bonusMode = mode !== "base";
      const superBonus = mode === "super";
      if (profile.game === "zeus") {
        const s = require("../dice/DiceEngine.v5").spin(10000, { profile, rng, isFreeSpin: bonusMode, superBonus });
        rows.push([s.initialGrid, s.finalGrid, s.baseWin, s.multipliers.collected, s.scatterCount, s.jackpotSymbolCount]);
      } else {
        const engine = profile.game === "poseidon"
          ? require("../poseidon/spinEngine.v4")
          : require("../zenobia/spinEngine.v3");
        const s = engine.resolveSpin({ profile, rng, bonusMode, superBonus });
        rows.push([s.initialMatrix, s.finalMatrix, s.baseWin, s.multiplierSum, s.scatterCount, s.jackpotCount]);
      }
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

// --- loading --------------------------------------------------------------------

function register(profile) {
  validateProfile(profile);
  profiles.set(profile.id, deepFreeze(structuredClone(profile)));
  verified.delete(profile.id);
}

function loadDirectory(dir = __dirname) {
  for (const game of GAMES) {
    const gameDir = path.join(dir, game);
    if (!fs.existsSync(gameDir)) continue;
    for (const file of fs.readdirSync(gameDir).filter((f) => f.endsWith(".json")).sort()) {
      register(JSON.parse(fs.readFileSync(path.join(gameDir, file), "utf8")));
    }
  }
}

/** Recompute every profile's digest; returns { id: { ok, reason } }. */
function verifyAll() {
  const report = {};
  for (const profile of profiles.values()) {
    const digest = digestOutcomes(profile);
    const ok = digest === profile.digest;
    const entry = { ok, reason: ok ? null : "engine behaviour changed since calibration" };
    verified.set(profile.id, entry);
    report[profile.id] = entry;
  }
  return report;
}

function getProfile(id) {
  const profile = profiles.get(id);
  if (!profile) throw new Error(`UNKNOWN_SLOT_PROFILE:${id}`);
  return profile;
}

function hasProfile(id) {
  return profiles.has(id);
}

function isVerified(id) {
  return verified.get(id)?.ok === true;
}

function listProfiles(game) {
  return [...profiles.values()]
    .filter((p) => p.game === game)
    .sort((a, b) => a.targetRtp - b.targetRtp);
}

/** The profile a game runs when an admin has never chosen one. */
function defaultProfileId(game) {
  const match = listProfiles(game).find(
    (p) => p.status === "active" && Math.abs(p.targetRtp - DEFAULT_TARGET_RTP) < 1e-9,
  );
  return match ? match.id : null;
}

function clearForTests() {
  profiles.clear();
  verified.clear();
}

loadDirectory();

module.exports = {
  GAMES,
  ENGINE_VERSIONS,
  DEFAULT_TARGET_RTP,
  validateProfile,
  digestOutcomes,
  register,
  loadDirectory,
  verifyAll,
  getProfile,
  hasProfile,
  isVerified,
  listProfiles,
  defaultProfileId,
  clearForTests,
};
