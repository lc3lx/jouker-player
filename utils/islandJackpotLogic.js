/** Pure logic — unit-testable without Mongo. */

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

/**
 * Compute armed/hot flags without mutating the pool document.
 */
function computePoolFlags(pool) {
  const balance = toSafeInt(pool?.poolBalance, 0);
  const minTrigger = toSafeInt(pool?.minTriggerAmount, 100_000_000);
  const hotThreshold = toSafeInt(
    pool?.settings?.hotJackpotThreshold,
    minTrigger
  );
  return {
    balance,
    minTrigger,
    hotThreshold,
    armed: balance >= minTrigger,
    hotJackpot: balance >= hotThreshold,
  };
}

/**
 * @returns {{ totalPayout: number, shareEach: number, actualTotal: number }|null}
 */
function calculatePayoutShares(poolBalance, percentage, winnerCount) {
  const winners = toSafeInt(winnerCount, 0);
  if (winners <= 0) return null;
  const pct = Number(percentage);
  if (!Number.isFinite(pct) || pct <= 0) return null;

  const poolBefore = toSafeInt(poolBalance, 0);
  if (poolBefore <= 0) return null;

  let totalPayout = Math.floor(poolBefore * pct);
  if (totalPayout <= 0) return null;
  if (totalPayout > poolBefore) totalPayout = poolBefore;

  const shareEach = Math.floor(totalPayout / winners);
  if (shareEach <= 0) return null;

  return {
    totalPayout,
    shareEach,
    actualTotal: shareEach * winners,
  };
}

function isAnnouncementsEnabled(pool) {
  return pool?.settings?.announcementsEnabled !== false;
}

function isEffectsEnabled(pool) {
  return pool?.settings?.effectsEnabled !== false;
}

module.exports = {
  toSafeInt,
  computePoolFlags,
  calculatePayoutShares,
  isAnnouncementsEnabled,
  isEffectsEnabled,
};
