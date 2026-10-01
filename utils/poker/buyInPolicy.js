"use strict";

const POKER_STAKES = Object.freeze({
  beginner: [10000, 40000, 100000, 150000],
  intermediate: [200000, 400000, 800000, 1000000],
  beast: [1500000, 2000000, 5000000, 10000000],
});

function maximumBuyIn(tier, base) {
  if (!POKER_STAKES[tier]?.includes(Number(base))) return Number(base);
  if (tier === "beginner") return Number(base) === 150000 ? 10000000 : 1000000;
  if (tier === "intermediate") return 100000000;
  return Number(base) === 10000000 ? 10000000000 : 1000000000;
}

function validBuyIn(amount, min, max) {
  return Number.isSafeInteger(amount) && amount >= min && amount <= max;
}

module.exports = { POKER_STAKES, maximumBuyIn, validBuyIn };
