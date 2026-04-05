const Card = require('./Card');

class Deck {
  constructor() {
    this.cards = [];
    this.suits = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
    this.ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    this.init();
  }

  init() {
    this.cards = [];
    for (const suit of this.suits) {
      for (const rank of this.ranks) {
        this.cards.push(new Card(suit, rank));
      }
    }
  }

  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  deal() {
    return this.cards.pop();
  }

  dealCardsToPlayers(players) {
    this.init();
    this.shuffle();
    for (const p of players) {
      p.hand = [];
    }
    let pIdx = 0;
    while (this.cards.length > 0) {
      players[pIdx].hand.push(this.deal());
      pIdx = (pIdx + 1) % players.length;
    }
    // Sort hands
    for (const p of players) {
      p.hand.sort((a, b) => {
        if (a.suit === b.suit) return a.value - b.value;
        return a.suit.localeCompare(b.suit);
      });
    }
  }
}

module.exports = Deck;
