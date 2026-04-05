/**
 * Unified card representation and utilities.
 * Card format: { suit, rank } where suit in ["hearts","spades","clubs","diamonds"], rank 2..14
 */
const SUITS = ["hearts", "spades", "clubs", "diamonds"];
const SUIT_CHARS = { h: "hearts", d: "diamonds", c: "clubs", s: "spades" };
const CHAR_SUITS = { hearts: "h", diamonds: "d", clubs: "c", spades: "s" };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]; // 11=J, 12=Q, 13=K, 14=A

/** Create full deck as { suit, rank } */
function newDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ suit: s, rank: r });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function draw(deck, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(deck.pop());
  return out;
}

/** Convert from short format (e.g. "Ah", "Td") to { suit, rank } */
function fromShort(str) {
  if (!str || str.length < 2) return null;
  const r = str[0];
  const s = SUIT_CHARS[str[1]];
  if (!s) return null;
  const rankMap = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };
  return { suit: s, rank: rankMap[r] };
}

/** Convert { suit, rank } to short format */
function toShort(card) {
  if (!card || !card.suit) return null;
  const r = card.rank === 10 ? "T" : card.rank === 11 ? "J" : card.rank === 12 ? "Q" : card.rank === 13 ? "K" : card.rank === 14 ? "A" : String(card.rank);
  const s = CHAR_SUITS[card.suit];
  return s ? r + s : null;
}

/** Compare two cards: returns 1 if a > b, -1 if a < b, 0 if equal. Uses trump and ledSuit. */
function compareCards(a, b, trump, ledSuit) {
  const aTrump = a.suit === trump;
  const bTrump = b.suit === trump;
  if (aTrump && !bTrump) return 1;
  if (!aTrump && bTrump) return -1;
  if (aTrump && bTrump) return Math.sign(a.rank - b.rank);
  const aLed = a.suit === ledSuit;
  const bLed = b.suit === ledSuit;
  if (aLed && !bLed) return 1;
  if (!aLed && bLed) return -1;
  if (aLed && bLed) return Math.sign(a.rank - b.rank);
  return 0;
}

/** Find winner in trick: cards = [{ card, playerIndex }], ledSuit from first card, trump */
function winningCardInTrick(cards, ledSuit, trump) {
  if (!cards.length) return null;
  const suit = ledSuit || cards[0].card.suit;
  let best = cards[0];
  for (let i = 1; i < cards.length; i++) {
    if (compareCards(cards[i].card, best.card, trump, suit) > 0) best = cards[i];
  }
  return best;
}

module.exports = {
  SUITS,
  RANKS,
  newDeck,
  shuffle,
  draw,
  fromShort,
  toShort,
  compareCards,
  winningCardInTrick,
};
