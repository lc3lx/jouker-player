/**
 * TarneebBot - bot decision logic for Tarneeb41.
 *
 * Extracted verbatim from Tarneeb41Game.js's `_botBid()`/`_pickAutoPlayCard()`
 * (no behavior change) - both were already pure functions reading only
 * instance fields as inputs, so extraction is a mechanical parameterization.
 * Tarneeb41Game.js's methods of the same name now delegate here.
 */
class TarneebBot {
  /** Estimate expected tricks for a hand based on hand strength. */
  static botBid(hand, trump) {
    if (!hand || hand.length === 0) return 0;
    let expected = 0;
    for (const c of hand) {
      if (c.rank === 14) expected += 1.0; // Ace
      else if (c.rank === 13) expected += 0.75; // King
      else if (c.rank === 12) expected += 0.5; // Queen
      if (trump && c.suit === trump) expected += 0.4; // trump bonus
    }
    const bid = Math.round(expected);
    if (bid < 2) return 0; // pass
    return Math.min(bid, 13);
  }

  static pickAutoPlayCard(hand, ledSuit, rules) {
    const valid = rules.getValidCards(hand, ledSuit);
    const pool = valid.length > 0 ? valid : [...hand];
    if (pool.length === 0) return null;
    pool.sort((a, b) => a.rank - b.rank);
    return pool[0];
  }
}

module.exports = TarneebBot;
