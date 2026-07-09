"use strict";

const { mergeRequirements } = require("../config/qualificationDefaults");

const NUMERIC_KEYS = [
  "minLevel",
  "minXp",
  "minRecharge",
  "minHandsPlayed",
  "minSpins",
  "minGamesPlayed",
  "minCompletedMatches",
  "minActiveDays",
  "accountAgeDays",
];

function normalizeRequirements(raw) {
  const merged = mergeRequirements(raw?.requirements || raw);
  const out = {};
  for (const k of NUMERIC_KEYS) {
    out[k] = Math.max(0, Math.floor(Number(merged[k]) || 0));
  }
  return out;
}

function validateRequirements(raw) {
  const req = normalizeRequirements(raw);
  return { ok: true, requirements: req };
}

module.exports = {
  normalizeRequirements,
  validateRequirements,
  NUMERIC_KEYS,
};
