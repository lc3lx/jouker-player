/**
 * TarneebBot — bid and card play for Tarneeb Syrian 41.
 *
 * Syrian 41 scores **per player**, not per team: each seat declares how many
 * tricks it will take, makes its own bid or breaks it, and the team total races
 * to 41. Everything here follows from that:
 *
 *   • Under your bid → win tricks, as cheaply as you can.
 *   • Bid already made → an extra trick pays you nothing, but taking one away
 *     from an opponent who still needs tricks breaks their bid and hands your
 *     team half of it each. So over-taking is worth it exactly when it busts
 *     someone, and never when it robs your own partner.
 *   • Trump is the off-suit of the same colour as the revealed card, so it is
 *     known to everyone from the deal — no guessing.
 *
 * The bot sees only what a player at the table sees: its own hand, the cards on
 * the table, the cards already played this round, the declared bids and the
 * trick counts. It never reads another seat's hand.
 *
 * `opts` still carries personality/skill. A lower-skill bot occasionally takes
 * the second-best line instead of a random legal card — a believable misread,
 * not a card dump. Called with no context (`ctx`), play falls back to the old
 * lowest-card behaviour so nothing that has not been updated can break.
 */
const botBehaviorService = require('../../services/botBehaviorService');

const RANK_A = 14;
const RANK_K = 13;
const RANK_Q = 12;
const RANK_J = 11;
const TRICKS_PER_ROUND = 13;
/** Declared sum below this redeals the hand (tarneeb41.rules.SUM_MIN_TO_PLAY). */
const SUM_MIN_TO_PLAY = 11;
/** How far above the honest estimate a bid sits. See botBid. */
const BID_OPTIMISM = 0.6;
/** Ceiling on the last bidder's stretch to save a deal from a redeal. */
const MAX_BID_STRETCH = 2;
/** The table's lowest legal declaration (tarneeb41.rules.MIN_DECLARE). */
const MIN_DECLARE = 2;

function bySuit(cards, suit) {
  return cards.filter((c) => c.suit === suit);
}

/** Rank of the card currently winning the trick, from [seat]'s point of view. */
function trickLeaderEntry(trick, ledSuit, trump) {
  if (!trick || trick.length === 0) return null;
  let best = trick[0];
  for (const entry of trick.slice(1)) {
    if (beats(entry.card, best.card, ledSuit, trump)) best = entry;
  }
  return best;
}

/** Does `card` beat `other`, given the led suit and trump? */
function beats(card, other, ledSuit, trump) {
  const cardTrump = trump && card.suit === trump;
  const otherTrump = trump && other.suit === trump;
  if (cardTrump && !otherTrump) return true;
  if (!cardTrump && otherTrump) return false;
  if (card.suit === other.suit) return card.rank > other.rank;
  // A card off both trump and the led suit can never win.
  return card.suit === ledSuit && other.suit !== ledSuit;
}

/**
 * Every card of `suit` still unseen — not in my hand, not on the table, not
 * already played this round. These are the cards the other three seats hold.
 */
function outstanding(suit, hand, seen) {
  const mine = new Set(bySuit(hand, suit).map((c) => c.rank));
  const gone = new Set(
    (seen || []).filter((c) => c.suit === suit).map((c) => c.rank),
  );
  const left = [];
  for (let r = 2; r <= RANK_A; r += 1) {
    if (!mine.has(r) && !gone.has(r)) left.push(r);
  }
  return left;
}

/** True when nothing outstanding in that suit can beat `card`. */
function isSuitMaster(card, hand, seen) {
  const left = outstanding(card.suit, hand, seen);
  return left.every((r) => r < card.rank);
}

/**
 * Tricks this hand should take. Counts near-certain winners rather than adding
 * fractions of a trick for every face card — the old estimate gave an ace, a
 * king and a queen 2.25 tricks in a suit where two of them are dead on arrival.
 */
function estimateTricks(hand, trump) {
  if (!hand || hand.length === 0) return 0;
  let expected = 0;
  const suits = [...new Set(hand.map((c) => c.suit))];

  for (const suit of suits) {
    const cards = bySuit(hand, suit).sort((a, b) => b.rank - a.rank);
    const isTrump = trump && suit === trump;
    const len = cards.length;

    for (let i = 0; i < len; i += 1) {
      const r = cards[i].rank;
      if (r === RANK_A) expected += isTrump ? 1 : 0.95;
      // A king needs a card under it to survive the ace, and even then it is
      // only good half the time off-trump.
      else if (r === RANK_K) expected += len >= 2 ? (isTrump ? 0.85 : 0.6) : 0.35;
      else if (r === RANK_Q) expected += len >= 3 ? (isTrump ? 0.6 : 0.35) : 0.15;
      else if (r === RANK_J && isTrump && len >= 4) expected += 0.35;
      else if (isTrump && len >= 5) expected += 0.25; // long trumps grind out tricks
    }

    // Shortness off-trump is a ruffing chance, but only while trumps remain.
    if (!isTrump && trump) {
      const trumpLen = bySuit(hand, trump).length;
      if (len === 0) expected += Math.min(trumpLen, 2) * 0.5;
      else if (len === 1) expected += Math.min(trumpLen, 2) * 0.3;
    }
  }

  return expected;
}

class TarneebBot {
  /**
   * Declare a number of tricks.
   *
   * The honest trick estimate is deliberately not the bid. Syrian 41 redeals
   * whenever the four declarations add up to under 11, and four honest bids on
   * a 13-trick deal add up to about nine — a table of purely honest bidders
   * redeals nine hands out of ten and never plays. Real players are optimistic
   * for exactly that reason, so BID_OPTIMISM carries the bid to where the hand
   * is actually playable.
   *
   * @param opts optional { personality, skill, tuning } — aggressive bots push a
   *   borderline hand up one; a skill slip misjudges by one either way.
   * @param ctx  optional { seat, declaredBids } — lets the last seat to declare
   *   stretch, within reason, rather than force a redeal on everyone.
   */
  static botBid(hand, trump, opts = null, ctx = null) {
    if (!hand || hand.length === 0) return 0;
    const expected = estimateTricks(hand, trump);
    let bid = Math.round(expected + BID_OPTIMISM);

    if (opts && opts.tuning) {
      if ((opts.tuning.raiseMul || 1) > 1.5 && botBehaviorService.rand01() < 0.3) bid += 1;
      if (botBehaviorService.shouldMisplayCardGame(opts.skill, opts.tuning)) {
        bid += botBehaviorService.rand01() < 0.5 ? -1 : 1;
      }
    }

    bid = TarneebBot._stretchToTableMinimum(bid, ctx);

    // Below the table minimum there is nothing to gain by declaring.
    if (bid < MIN_DECLARE) return 0;
    return Math.min(bid, TRICKS_PER_ROUND);
  }

  /**
   * Last seat to declare, and the table is short of the minimum: reaching it is
   * worth a trick of risk, since the alternative is throwing the deal away.
   * Never stretches more than MAX_BID_STRETCH over the honest read — a hopeless
   * hand lets the redeal happen rather than declaring a bid it cannot make.
   */
  static _stretchToTableMinimum(bid, ctx) {
    if (!ctx || !Array.isArray(ctx.declaredBids) || ctx.seat == null) return bid;
    // A hand too weak to declare at all is not dragged into a bid it cannot
    // make; the redeal is the right outcome there.
    if (bid < MIN_DECLARE) return bid;
    const others = ctx.declaredBids.filter((_, i) => i !== ctx.seat);
    if (others.some((b) => b == null)) return bid; // not the last to declare
    const sum = others.reduce((a, b) => a + (b || 0), 0);
    const shortfall = SUM_MIN_TO_PLAY - (sum + bid);
    if (shortfall <= 0) return bid;
    return bid + Math.min(shortfall, MAX_BID_STRETCH);
  }

  /**
   * @param {Array} hand      the bot's cards
   * @param {string} ledSuit  suit led this trick, null when leading
   * @param {object} rules    tarneeb41.rules (for getValidCards)
   * @param {object} [opts]   personality/skill
   * @param {object} [ctx]    table context — without it, legacy lowest-card play
   * @param {number} ctx.seat            this bot's seat index
   * @param {Array}  ctx.trick           [{ card, playerIndex }] played so far
   * @param {string} ctx.trump           trump suit
   * @param {Array}  ctx.declaredBids    per-seat bids (null before declaring)
   * @param {Array}  ctx.tricksTaken     per-seat tricks won this round
   * @param {Array}  ctx.playedCards     every card played this round
   */
  static pickAutoPlayCard(hand, ledSuit, rules, opts = null, ctx = null) {
    const valid = rules.getValidCards(hand, ledSuit);
    const pool = valid.length > 0 ? valid : [...hand];
    if (pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    if (!ctx || ctx.seat == null) {
      // No table context (timeout auto-play on an un-migrated path): keep the
      // old safe default rather than guessing — including its random-card
      // slip, since without a ranking there is no second-best line to take.
      if (opts && opts.skill && botBehaviorService.shouldMisplayCardGame(opts.skill, opts.tuning)) {
        return pool[Math.floor(botBehaviorService.rand01() * pool.length)];
      }
      pool.sort((a, b) => a.rank - b.rank);
      return pool[0];
    }

    const ranked = TarneebBot.rankPlays(pool, hand, ledSuit, ctx);

    // A skill slip takes the second-best line, not a random card — a human
    // misreads the count, they do not throw the hand away.
    if (
      opts &&
      opts.skill &&
      ranked.length > 1 &&
      botBehaviorService.shouldMisplayCardGame(opts.skill, opts.tuning)
    ) {
      return ranked[1].card;
    }

    return ranked[0].card;
  }

  /**
   * Score every legal card, best first. Exposed for tests: the ordering is the
   * whole strategy, and it is far easier to assert on than a single pick.
   */
  static rankPlays(pool, hand, ledSuit, ctx) {
    const {
      seat,
      trick = [],
      trump = null,
      declaredBids = [],
      tricksTaken = [],
      playedCards = [],
    } = ctx;

    const partner = (seat + 2) % 4;
    const seen = [...playedCards, ...trick.map((t) => t.card)];

    const need = (i) => {
      const bid = declaredBids[i];
      if (bid == null || bid === 0) return 0;
      return Math.max(0, bid - (tricksTaken[i] || 0));
    };

    const myNeed = need(seat);
    const partnerNeed = need(partner);
    const opponents = [(seat + 1) % 4, (seat + 3) % 4];

    const leader = trickLeaderEntry(trick, ledSuit, trump);
    const leaderSeat = leader ? leader.playerIndex : null;
    const partnerWinning = leaderSeat === partner;
    const opponentWinning = leaderSeat != null && opponents.includes(leaderSeat);
    // Busting a bid is worth the opponent's whole bid, split between us.
    const bustTarget =
      opponentWinning && need(leaderSeat) > 0 ? leaderSeat : null;
    const last = trick.length === 3;

    // How badly do I want this trick?
    //  >0 wants it, <0 wants to avoid it, 0 indifferent.
    let appetite = 0;
    if (myNeed > 0) appetite = 2;
    else if (bustTarget != null) appetite = 1;
    else if (partnerWinning && partnerNeed > 0) appetite = -2;
    else appetite = -1;

    const scored = pool.map((card) => {
      const winsNow = !leader || beats(card, leader.card, ledSuit, trump);
      // Only a last-seat win is certain; earlier it is a bid, not a lock.
      const takesTrick = winsNow && last;
      const mightTake = winsNow && !last;
      const master = isSuitMaster(card, hand, seen);
      const isTrump = trump && card.suit === trump;

      let score = 0;

      if (!leader) {
        score = TarneebBot._scoreLead(card, hand, seen, {
          appetite,
          trump,
          master,
        });
      } else if (appetite > 0) {
        if (takesTrick || (mightTake && master)) {
          // Win as cheaply as possible, and do not burn a trump on a trick a
          // plain card already takes.
          score = 100 - card.rank;
          if (isTrump && card.suit !== ledSuit) score -= 12;
          if (bustTarget != null) score += 20;
        } else if (mightTake) {
          score = 60 - card.rank;
          if (isTrump && card.suit !== ledSuit) score -= 12;
        } else {
          // Cannot win — throw the cheapest thing and keep the winners.
          score = 20 - card.rank;
          if (master) score -= 25;
          if (isTrump) score -= 20;
        }
      } else {
        // Ducking. Play as high as is still safe so the big cards go early and
        // do not strand me on lead later.
        if (takesTrick || (mightTake && master)) {
          score = -40 - card.rank;
          if (isTrump) score -= 20;
        } else {
          score = 40 + card.rank;
          if (master) score -= 35; // keep masters for tricks I actually need
          if (isTrump) score -= 30; // never waste a trump on a trick I am dodging
          // Dumping into a partner's winning trick is free, so dump the card
          // that is most in the way.
          if (partnerWinning) score += 6;
        }
      }

      return { card, score, winsNow, master };
    });

    scored.sort((a, b) => b.score - a.score || a.card.rank - b.card.rank);
    return scored;
  }

  /** Leading is a separate problem: nobody has committed yet. */
  static _scoreLead(card, hand, seen, { appetite, trump, master }) {
    const isTrump = trump && card.suit === trump;
    const suitLen = bySuit(hand, card.suit).length;
    let score = 0;

    if (appetite > 0) {
      // Cash a certain winner; otherwise lead long suits to promote the rest.
      if (master) score = 90 + card.rank / 10 + suitLen;
      else score = 30 + card.rank / 4 + suitLen;
      // Drawing trumps is right only when I hold the strength there.
      if (isTrump) score += bySuit(hand, trump).length >= 4 ? 8 : -15;
    } else {
      // Not chasing this trick: lead something small that cannot win, and keep
      // masters and trumps back.
      score = 60 - card.rank;
      if (master) score -= 40;
      if (isTrump) score -= 35;
      // A short suit is worth clearing so I can ruff later.
      if (suitLen <= 2) score += 5;
    }

    return score;
  }
}

module.exports = TarneebBot;
module.exports.estimateTricks = estimateTricks;
module.exports.beats = beats;
module.exports.outstanding = outstanding;
module.exports.isSuitMaster = isSuitMaster;
