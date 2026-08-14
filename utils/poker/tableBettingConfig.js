const { toSafeInt } = require("../pokerTableStatus");

/**
 * Table minimum opening bet — default buyIn / 10 (10% of table value).
 * Admin override via table.minimumBet when > 0.
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
 * Table stakes from buy-in:
 *   minimumBet = bigBlind = buyIn / 10  (e.g. 10k table → 1k min bet)
 *   smallBlind = bigBlind / 2
 */
function deriveBlindsFromBuyIn(buyIn) {
  const buyInVal = Math.max(0, toSafeInt(buyIn, 0));
  const minimumBet = deriveMinimumBet(buyInVal);
  const bigBlind = Math.max(1, minimumBet);
  const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
  return { smallBlind, bigBlind, minimumBet, buyIn: buyInVal };
}

/**
 * Resolve poker table betting fields from a Mongo table doc or plain object.
 * Blinds follow the same 10% rule so BB === minimumBet by default.
 */
function resolvePokerTableBettingConfig(table = {}) {
  const buyIn = toSafeInt(table.buyIn ?? table.minBuyIn, 0);
  const minimumBet = deriveMinimumBet(buyIn, table.minimumBet);
  const bigBlindRaw = toSafeInt(table.bigBlind, 0);
  const smallBlindRaw = toSafeInt(table.smallBlind, 0);
  const bigBlind = bigBlindRaw > 0 ? bigBlindRaw : Math.max(1, minimumBet);
  const smallBlind =
    smallBlindRaw > 0 ? smallBlindRaw : Math.max(1, Math.floor(bigBlind / 2));
  return { buyIn, minimumBet, smallBlind, bigBlind };
}

module.exports = {
  deriveMinimumBet,
  deriveBlindsFromBuyIn,
  resolvePokerTableBettingConfig,
};
