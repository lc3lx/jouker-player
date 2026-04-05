class Card {
  constructor(suit, rank) {
    this.suit = suit; // 'Spades', 'Hearts', 'Diamonds', 'Clubs'
    this.rank = rank; // '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'
    this.value = this.calculateValue(rank);
  }

  calculateValue(rank) {
    if (!isNaN(parseInt(rank))) return parseInt(rank);
    if (rank === 'J') return 11;
    if (rank === 'Q') return 12;
    if (rank === 'K') return 13;
    if (rank === 'A') return 14;
    return 0;
  }
}

module.exports = Card;
