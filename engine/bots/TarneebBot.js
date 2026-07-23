/**
 * TarneebBot - bot decision logic for Tarneeb41.
 *
 * Extracted verbatim from Tarneeb41Game.js's `_botBid()`/`_pickAutoPlayCard()`
 * (no behavior change) - both were already pure functions reading only
 * instance fields as inputs, so extraction is a mechanical parameterization.
 * Tarneeb41Game.js's methods of the same name now delegate here.
 */
const botBehaviorService = require('../../services/botBehaviorService');

class TarneebBot {
  /**
   * Estimate expected tricks for a hand based on hand strength.
   * @param opts optional { personality, skill, tuning } — aggressive/risky bots
   *   occasionally bid one higher; low-skill bots occasionally misjudge by ±1.
   *   With NO opts the bid is IDENTICAL to before.
   */
  static botBid(hand, trump, opts = null) {
    if (!hand || hand.length === 0) return 0;
    let expected = 0;
    for (const c of hand) {
      if (c.rank === 14) expected += 1.0; // Ace
      else if (c.rank === 13) expected += 0.75; // King
      else if (c.rank === 12) expected += 0.5; // Queen
      if (trump && c.suit === trump) expected += 0.4; // trump bonus
    }
    let bid = Math.round(expected);
    if (opts && opts.tuning) {
      // Aggression nudges the bid up; a skill misjudge nudges it either way.
      if ((opts.tuning.raiseMul || 1) > 1.5 && botBehaviorService.rand01() < 0.3) bid += 1;
      if (botBehaviorService.shouldMisplay(opts.skill, opts.tuning)) {
        bid += botBehaviorService.rand01() < 0.5 ? -1 : 1;
      }
    }
    if (bid < 2) return 0; // pass
    return Math.min(Math.max(bid, 0), 13);
  }

  /**
   * @param opts optional { personality, skill, tuning } — low-skill bots
   *   occasionally play a random legal card instead of the lowest. Default: lowest.
   */
  static pickAutoPlayCard(hand, ledSuit, rules, opts = null) {
    const valid = rules.getValidCards(hand, ledSuit);
    const pool = valid.length > 0 ? valid : [...hand];
    if (pool.length === 0) return null;
    if (opts && opts.skill && botBehaviorService.shouldMisplay(opts.skill, opts.tuning)) {
      return pool[Math.floor(botBehaviorService.rand01() * pool.length)];
    }
    pool.sort((a, b) => a.rank - b.rank);
    return pool[0];
  }
}

module.exports = TarneebBot;
