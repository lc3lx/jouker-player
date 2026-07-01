const { toSafeInt } = require("../pokerTableStatus");

/**
 * Table minimum opening bet — default buyIn / 10, admin override via table.minimumBet.
 * @param {number} buyIn
 * @param {number|null|undefined} override
 */
function deriveMinimumBet(buyIn, override) {
  const o = toSafeInt(override, 0);
  if (o > 0) return o;
  const bi = toSafeInt(buyIn, 0);
  if (bi <= 0) return 1;
  return Math.max(1, Math.floor(bi / 10));
}

/**
 * Resolve poker table betting fields from a Mongo table doc or plain object.
 */
function resolvePokerTableBettingConfig(table = {}) {
  const buyIn = toSafeInt(table.buyIn ?? table.minBuyIn, 0);
  const minimumBet = deriveMinimumBet(buyIn, table.minimumBet);
  const smallBlind = toSafeInt(table.smallBlind, 0);
  const bigBlind = toSafeInt(table.bigBlind, 0);
  return { buyIn, minimumBet, smallBlind, bigBlind };
}

module.exports = { deriveMinimumBet, resolvePokerTableBettingConfig };
