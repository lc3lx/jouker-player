"use strict";

const DEFAULT_INVITEE_ELIGIBILITY = {
  accountAgeDays: 3,
  minXp: 500,
  minLevel: 0,
  minRecharge: 0,
  minHandsPlayed: 10,
  minSpins: 0,
  minGamesPlayed: 5,
  minCompletedMatches: 0,
  minActiveDays: 2,
};

function mergeRequirements(...parts) {
  const out = { ...DEFAULT_INVITEE_ELIGIBILITY };
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    for (const [k, v] of Object.entries(p)) {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isNaN(n)) out[k] = Math.max(out[k] || 0, n);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_INVITEE_ELIGIBILITY,
  mergeRequirements,
};
