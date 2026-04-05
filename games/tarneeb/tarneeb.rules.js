/**
 * Tarneeb (طرنيب) - rules and validation.
 * 4 players, teams 0+2 vs 1+3.
 * Bidding 7-13, highest bidder chooses trump.
 * Follow suit, trump beats non-trump.
 */

const { SUITS } = require("../utils/cards");

const MIN_BID = 7;
const MAX_BID = 13;
const TARGET_SCORE = 31;

/** Team for seat index: 0,2 = team 0; 1,3 = team 1 */
function getTeam(seatIndex) {
  return seatIndex % 2;
}

/** Partner seat index */
function getPartner(seatIndex) {
  return (seatIndex + 2) % 4;
}

/** Validate bid: 7-13, must be higher than current bid or pass */
function validateBid(currentBid, bidValue) {
  if (bidValue === null || bidValue === "pass") return { valid: true, pass: true };
  const v = parseInt(bidValue, 10);
  if (isNaN(v) || v < MIN_BID || v > MAX_BID) return { valid: false };
  if (v <= (currentBid || 0)) return { valid: false };
  return { valid: true, pass: false, value: v };
}

/** Validate card play: must follow suit if able */
function validateCardPlay(hand, card, ledSuit, trump) {
  const idx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
  if (idx < 0) return { valid: false, reason: "card_not_in_hand" };

  if (!ledSuit) return { valid: true }; // First card of trick
  const hasLed = hand.some((c) => c.suit === ledSuit);
  if (hasLed && card.suit !== ledSuit) return { valid: false, reason: "must_follow_suit" };
  return { valid: true };
}

/** Get valid cards to play */
function getValidCards(hand, ledSuit) {
  if (!ledSuit) return [...hand];
  const ofSuit = hand.filter((c) => c.suit === ledSuit);
  return ofSuit.length > 0 ? ofSuit : [...hand];
}

module.exports = {
  MIN_BID,
  MAX_BID,
  TARGET_SCORE,
  SUITS,
  getTeam,
  getPartner,
  validateBid,
  validateCardPlay,
  getValidCards,
};
