/**
 * TrixBot — contract choice and card play for Trix (تريكس).
 *
 * A دق is 4 kingdoms × 5 contracts. Four of them are penalties you dodge and
 * one is a race you win:
 *
 *   Diamonds      −10 per diamond taken
 *   Tricks        −15 per trick taken
 *   Queens        −25 per queen taken
 *   KingOfHearts  −75 for taking K♥
 *   Trix          +200/150/100/50 by finishing order (the ladder)
 *
 * So four contracts share one skill — never win a trick that holds a penalty —
 * and the fifth is a completely different game. The old bot led its lowest card
 * and followed with its lowest card in every contract, which throws away the
 * two plays that decide these hands: ducking *high* (so the dangerous cards go
 * early, instead of stranding you on lead at the end holding the ace) and
 * dumping the penalty card the moment you are void.
 *
 * Everything below reads only what a seat at the table can see: its own hand,
 * the cards on the table, the cards already played this contract, the Trix
 * ladder and who has finished. It never looks at another player's hand.
 *
 * Partnership tables (تركس شركة) change the scoring unit, not the cards — the
 * contracts and their penalties are identical — so the same play logic serves
 * both, with `ctx.partnerIndex` supplied when facing seats are a team.
 */
const botBehaviorService = require('../../services/botBehaviorService');

const CONTRACTS = ['Diamonds', 'Tricks', 'Queens', 'KingOfHearts', 'Trix'];
const JACK_VALUE = 11;

function isQueen(card) {
  return card.rank === 'Q';
}

function isKingOfHearts(card) {
  return card.rank === 'K' && card.suit === 'Hearts';
}

function bySuit(cards, suit) {
  return cards.filter((c) => c.suit === suit);
}

/** Highest card of the led suit currently on the table, or null. */
function trickWinnerCard(gameState) {
  const led = gameState.leadingSuit;
  let best = null;
  for (const entry of gameState.tableCards || []) {
    if (!entry || !entry.card || entry.card.suit !== led) continue;
    if (!best || entry.card.value > best.value) best = entry.card;
  }
  return best;
}

/** Seat currently winning the trick, or null when nobody has led yet. */
function trickWinnerSeat(gameState) {
  const led = gameState.leadingSuit;
  let best = null;
  let seat = null;
  for (const entry of gameState.tableCards || []) {
    if (!entry || !entry.card || entry.card.suit !== led) continue;
    if (!best || entry.card.value > best.value) {
      best = entry.card;
      seat = entry.playerIndex;
    }
  }
  return seat;
}

/**
 * Penalty points sitting in the current trick, by contract. This is what makes
 * a trick worth dodging rather than a trick like any other.
 */
function trickPenalty(gameState, contract) {
  const cards = (gameState.tableCards || [])
    .map((e) => e && e.card)
    .filter(Boolean);
  if (contract === 'Diamonds') {
    return cards.filter((c) => c.suit === 'Diamonds').length * 10;
  }
  if (contract === 'Queens') return cards.filter(isQueen).length * 25;
  if (contract === 'KingOfHearts') return cards.some(isKingOfHearts) ? 75 : 0;
  if (contract === 'Tricks') return 15; // every trick costs the same
  return 0;
}

/** Penalty a single card carries in this contract. */
function cardPenalty(card, contract) {
  if (contract === 'Diamonds') return card.suit === 'Diamonds' ? 10 : 0;
  if (contract === 'Queens') return isQueen(card) ? 25 : 0;
  if (contract === 'KingOfHearts') return isKingOfHearts(card) ? 75 : 0;
  return 0;
}

/**
 * Cards of `suit` nobody has seen yet — not mine, not played this contract,
 * not on the table. These are what the other seats still hold.
 */
function outstandingValues(suit, hand, gameState) {
  const mine = new Set(bySuit(hand, suit).map((c) => c.value));
  const gone = new Set(
    [
      ...(gameState.roundPlayedCards || []),
      ...(gameState.tableCards || []).map((e) => e && e.card),
    ]
      .filter((c) => c && c.suit === suit)
      .map((c) => valueOf(c)),
  );
  const left = [];
  for (let v = 2; v <= 14; v += 1) {
    if (!mine.has(v) && !gone.has(v)) left.push(v);
  }
  return left;
}

/** `roundPlayedCards` stores {rank,suit} without a value — derive it. */
function valueOf(card) {
  if (typeof card.value === 'number') return card.value;
  const r = String(card.rank);
  const n = parseInt(r, 10);
  if (!Number.isNaN(n)) return n;
  if (r === 'J') return 11;
  if (r === 'Q') return 12;
  if (r === 'K') return 13;
  if (r === 'A') return 14;
  return 0;
}

class TrixBot {
  /**
   * @param opts optional { personality, skill, tuning } — a skill slip takes the
   *   second-ranked play rather than a random legal card, the way a human
   *   misreads a count instead of throwing the hand away. With NO opts the bot
   *   always plays its best line.
   */
  static botChooseCard(gameState, playerIndex, validCards, opts = null, ctx = null) {
    if (!validCards || validCards.length === 0) return null;
    if (validCards.length === 1) return validCards[0];

    const ranked =
      gameState.currentGameType === 'Trix'
        ? TrixBot.rankTrixPlays(gameState, playerIndex, validCards)
        : TrixBot.rankTrickPlays(gameState, playerIndex, validCards, ctx);

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
   * The four penalty contracts. One principle: do not take penalty points, and
   * when you cannot avoid taking a trick, take the cheapest one available and
   * shed your dangerous cards while you still have the chance.
   */
  static rankTrickPlays(gameState, playerIndex, validCards, ctx = null) {
    const contract = gameState.currentGameType;
    // A decision helper must never be the thing that takes a table down, so a
    // state missing the roster degrades to reasoning over the legal cards
    // alone rather than throwing.
    const hand = gameState.players?.[playerIndex]?.hand || validCards;
    const led = gameState.leadingSuit;
    const isLeading = (gameState.tableCards || []).length === 0;
    const isLast = (gameState.tableCards || []).length === 3;
    const best = trickWinnerCard(gameState);
    const pending = trickPenalty(gameState, contract);
    const partnerIndex = ctx && ctx.partnerIndex != null ? ctx.partnerIndex : null;
    const partnerWinning =
      partnerIndex != null && trickWinnerSeat(gameState) === partnerIndex;

    const scored = validCards.map((card) => {
      const mine = cardPenalty(card, contract);
      const followsLed = !led || card.suit === led;
      // Off-suit cards can never win; on-suit ones only if they top the table.
      const winsNow = followsLed && (!best || card.value > best.value);
      const certainWin = winsNow && isLast;
      const outstanding = outstandingValues(card.suit, hand, gameState);
      const unbeatable = outstanding.every((v) => v < card.value);

      let score = 0;

      if (isLeading) {
        score = TrixBot._scoreLead(card, hand, gameState, contract, unbeatable);
      } else if (!followsLed) {
        // Void in the led suit — a free discard, and the only safe moment to
        // unload the cards that cost points. Shed the most expensive one.
        score = 500 + mine * 4 + card.value / 10;
        // Under one condition dumping K♥ is not just safe but the whole hand:
        // it can never come back.
        if (contract === 'KingOfHearts' && isKingOfHearts(card)) score += 400;
      } else if (certainWin || (winsNow && unbeatable)) {
        // Taking the trick. Cost = the points in it plus what I add to it.
        // Among cards that all win, take it with the BIGGEST one: the trick is
        // lost either way, and the low cards are what I duck with later.
        const cost = pending + mine;
        score = -100 - cost * 3 + card.value / 10;
        // In Tricks every trick costs 15, so winning cheaply still hurts.
        if (contract === 'Tricks') score -= 40;
        // On a partnership table a trick my partner already holds costs us the
        // same either way, so there is nothing to gain by overtaking.
        if (partnerWinning) score -= 30;
      } else if (winsNow) {
        // Might still be beaten by whoever is left — risky, not fatal.
        score = -20 - (pending + mine) - card.value / 10;
      } else {
        // Safe: this card loses the trick. Duck as HIGH as is still safe, so
        // the big cards leave the hand now instead of stranding me on lead
        // with them at the end. This is the play the old bot never made.
        score = 200 + card.value;
        if (mine > 0) score += mine * 2; // and prefer shedding a penalty card
        if (unbeatable) score -= 60; // except a master: it is a liability later
      }

      return { card, score, winsNow, unbeatable };
    });

    scored.sort((a, b) => b.score - a.score || a.card.value - b.card.value);
    return scored;
  }

  /** Leading a penalty contract: get out cheaply, and flush danger suits. */
  static _scoreLead(card, hand, gameState, contract, unbeatable) {
    const suitLen = bySuit(hand, card.suit).length;
    const outstanding = outstandingValues(card.suit, hand, gameState);
    // How likely is this to come back and take the trick?
    const higherOut = outstanding.filter((v) => v > card.value).length;

    // Low cards are safe leads; a card with nothing above it left is a trap.
    let score = 100 + higherOut * 8 - card.value;
    if (unbeatable) score -= 120;

    if (contract === 'Diamonds') {
      // Leading a diamond hands the diamonds to whoever holds the higher one.
      // Fine while I hold low ones, terrible while I hold the ace.
      if (card.suit === 'Diamonds') score += higherOut >= 3 ? 25 : -60;
    } else if (contract === 'KingOfHearts') {
      if (isKingOfHearts(card)) score -= 300; // leading it is handing over 75
      // Flushing hearts from a short holding gets me void before the king moves.
      if (card.suit === 'Hearts' && suitLen <= 2 && higherOut >= 2) score += 20;
    } else if (contract === 'Queens') {
      if (isQueen(card)) score -= 200;
      // Draw out queens from a suit where I am safe underneath.
      if (higherOut >= 4) score += 12;
    } else if (contract === 'Tricks') {
      // Every trick is a loss, so lead the card least likely to win — and
      // prefer a long suit so I keep escape cards for later.
      score += suitLen * 4;
    }

    return score;
  }

  /**
   * The ladder (Trix). Scoring is finishing order, so the whole game is: get my
   * own cards playable, and do not open suits that free the others.
   *
   * A J opens its suit at 11 and the suit then grows one step up or down. So a
   * card is only ever playable when it sits directly next to what is already
   * down, which makes two things decisive:
   *   • open the suit where MY cards continue the chain, not where theirs do;
   *   • prefer the play that immediately unlocks another of my own cards.
   */
  static rankTrixPlays(gameState, playerIndex, validCards) {
    const hand = gameState.players?.[playerIndex]?.hand || validCards;

    const scored = validCards.map((card) => {
      const suitCards = bySuit(hand, card.suit);
      const suitStats = gameState.trixTable[card.suit] || {};
      const opened = suitStats.min != null && suitStats.max != null;
      const values = new Set(suitCards.map((c) => c.value));

      let score = 0;

      if (card.rank === 'J' && !opened) {
        // Opening a suit helps everyone. Worth it only where I hold the chain
        // around the jack; opening a suit I hold two cards in mostly frees the
        // other three players.
        const chain = TrixBot._chainLength(values, JACK_VALUE);
        score = 40 + chain * 22 + suitCards.length * 6;
        // The last suit has to be opened by someone eventually; if it is my
        // only legal move the single-card shortcut above already handled it.
        if (suitCards.length <= 1) score -= 40;
      } else {
        // Continuing an open suit. The best card is the one that immediately
        // makes another of mine legal, and beyond that the one that walks
        // towards the cards of mine that are stuck at the far end.
        const goingUp = card.value === (suitStats.max ?? JACK_VALUE) + 1;
        const nextStep = goingUp ? card.value + 1 : card.value - 1;
        const unlocks = values.has(nextStep);
        const runAhead = TrixBot._runFrom(values, card.value, goingUp ? 1 : -1);
        const stranded = TrixBot._strandedBeyond(values, card.value, goingUp ? 1 : -1);

        score = 120 + runAhead * 25 + (unlocks ? 30 : 0) + stranded * 8;
        // Playing the extreme cards (A, 2) is only possible via a long climb,
        // so start climbing early rather than holding them to the end.
        if (card.value === 14 || card.value === 2) score += 10;
      }

      return { card, score };
    });

    scored.sort((a, b) => b.score - a.score || a.card.value - b.card.value);
    return scored;
  }

  /** Length of my unbroken run through `values` starting at `from`, both ways. */
  static _chainLength(values, from) {
    let n = 0;
    for (let v = from + 1; values.has(v); v += 1) n += 1;
    for (let v = from - 1; values.has(v); v -= 1) n += 1;
    return n;
  }

  /** How many of my cards continue immediately from `value` in `dir`. */
  static _runFrom(values, value, dir) {
    let n = 0;
    for (let v = value + dir; values.has(v); v += dir) n += 1;
    return n;
  }

  /** My cards further out in `dir` that only this direction can ever reach. */
  static _strandedBeyond(values, value, dir) {
    let n = 0;
    for (let v = value + dir; v >= 2 && v <= 14; v += dir) {
      if (values.has(v)) n += 1;
    }
    return n;
  }

  /**
   * Choosing the contract as king. Picking `available[0]` meant every bot king
   * called Diamonds, then Tricks, then Queens — in that order, every single
   * kingdom. Now the king reads its own hand and calls the contract it is
   * safest in, which is the single most visible decision a Trix player makes.
   *
   * @returns one of `availableGames`
   */
  static botChooseGame(gameState, playerIndex, availableGames) {
    if (!availableGames || availableGames.length === 0) return null;
    if (availableGames.length === 1) return availableGames[0];

    const hand = gameState.players?.[playerIndex]?.hand || [];
    const scored = availableGames.map((contract) => ({
      contract,
      score: TrixBot.contractFitness(hand, contract),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored[0].contract;
  }

  /**
   * How good this hand is for a contract — higher is safer/more profitable.
   * Expressed roughly in points so the contracts are comparable to each other.
   */
  static contractFitness(hand, contract) {
    const suitLen = (s) => bySuit(hand, s).length;
    // A high card is only dangerous while the suit is long enough that I am
    // forced to follow with it.
    const dangerIn = (suit, predicate) =>
      bySuit(hand, suit).filter(predicate).length;

    if (contract === 'KingOfHearts') {
      const hasKing = hand.some(isKingOfHearts);
      if (!hasKing) return 70; // someone else owns the whole risk
      const hearts = suitLen('Hearts');
      const cover = dangerIn('Hearts', (c) => c.value < 13); // cards to duck with
      const ace = hand.some((c) => c.suit === 'Hearts' && c.value === 14);
      // Short hearts with the king is the nightmare: nothing to hide behind.
      let score = -60 + cover * 12;
      if (ace) score -= 15; // the ace forces me to win a heart trick
      if (hearts <= 2) score -= 30;
      return score;
    }

    if (contract === 'Queens') {
      const queens = hand.filter(isQueen);
      let score = 60 - queens.length * 30;
      for (const q of queens) {
        // A queen in a long suit can be ducked under; a singleton queen falls.
        score += Math.min(suitLen(q.suit), 5) * 6;
      }
      return score;
    }

    if (contract === 'Diamonds') {
      const diamonds = bySuit(hand, 'Diamonds');
      const high = diamonds.filter((c) => c.value >= 11).length;
      // Few diamonds, and low ones, is the hand to call this on.
      return 60 - diamonds.length * 6 - high * 18;
    }

    if (contract === 'Tricks') {
      // Every high card is a trick waiting to happen — count them across suits,
      // and forgive the ones sitting in a long suit with escape cards under.
      let danger = 0;
      for (const suit of ['Spades', 'Hearts', 'Diamonds', 'Clubs']) {
        const cards = bySuit(hand, suit);
        const highs = cards.filter((c) => c.value >= 12).length;
        const lows = cards.filter((c) => c.value <= 6).length;
        danger += highs * 12 - Math.min(lows, highs) * 5;
        if (cards.length === 0) danger -= 10; // a void is a free discard
      }
      return 60 - danger;
    }

    if (contract === 'Trix') {
      // The ladder rewards jacks and the cards packed around them.
      let score = 20;
      for (const suit of ['Spades', 'Hearts', 'Diamonds', 'Clubs']) {
        const values = new Set(bySuit(hand, suit).map((c) => c.value));
        if (values.has(JACK_VALUE)) {
          score += 25 + TrixBot._chainLength(values, JACK_VALUE) * 10;
        } else {
          // Cards far from a jack I do not hold may never become playable.
          const stranded = [...values].filter((v) => v <= 5 || v >= 13).length;
          score -= stranded * 6;
        }
      }
      return score;
    }

    return 0;
  }
}

module.exports = TrixBot;
module.exports.CONTRACTS = CONTRACTS;
module.exports.trickPenalty = trickPenalty;
module.exports.cardPenalty = cardPenalty;
module.exports.outstandingValues = outstandingValues;
