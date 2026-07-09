"use strict";

const XP_PER_LEVEL = 2500;

const XP_RATES = {
  depositPer100Chips: 1,
  pokerHand: 50,
  cardGame: 40,
  spin: 15,
};

const DEPOSIT_XP_TYPES = new Set([
  "deposit",
  "confirmed_deposit",
  "recharge",
  "agent_deposit_in",
]);

function xpFromDeposit(amount) {
  const chips = Math.max(0, Math.floor(Number(amount) || 0));
  return Math.floor(chips / 100) * XP_RATES.depositPer100Chips;
}

module.exports = {
  XP_PER_LEVEL,
  XP_RATES,
  DEPOSIT_XP_TYPES,
  xpFromDeposit,
};
