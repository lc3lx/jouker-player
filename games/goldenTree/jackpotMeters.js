/**
 * In-memory progressive jackpot meters for Golden Tree HUD (♣ ♦ ♥ ♠).
 * Soft increments each paid spin; jackpot hit awards and resets the top (♠) pool.
 */

const { roundMoney, JACKPOT_MULTIPLIER } = require("./constants");

const meters = {
  club: 92.04,
  diamond: 787.85,
  heart: 1903.27,
  spade: 202281.94,
};

function snapshot() {
  return {
    club: roundMoney(meters.club * 100) / 100,
    diamond: roundMoney(meters.diamond * 100) / 100,
    heart: roundMoney(meters.heart * 100) / 100,
    spade: roundMoney(meters.spade * 100) / 100,
  };
}

/** Tiny contribution from each paid spin so the bar feels alive. */
function contribute(betAmount) {
  const bet = Number(betAmount) || 0;
  const drip = Math.max(0.01, bet * 0.00002);
  meters.club += drip * 0.05;
  meters.diamond += drip * 0.15;
  meters.heart += drip * 0.3;
  meters.spade += drip * 0.5;
  return snapshot();
}

/**
 * Award jackpot amount for this bet, reset spade pool seed, return award + meters.
 */
function hitJackpot(betAmount) {
  const bet = Number(betAmount) || 0;
  const award = roundMoney(bet * JACKPOT_MULTIPLIER);
  meters.spade = Math.max(1000, bet * 10);
  return { award, meters: snapshot() };
}

/** Test helper — force meter values. */
function _setMetersForTest(next) {
  Object.assign(meters, next);
}

module.exports = {
  snapshot,
  contribute,
  hitJackpot,
  _setMetersForTest,
};
