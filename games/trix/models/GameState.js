const Deck = require('./Deck');

class GameState {
  constructor(players) {
    this.players = players;
    this.deck = new Deck();
    this.currentKingIndex = 0;
    this.currentGameType = null; // 'Diamonds', 'Tricks', 'Queens', 'KingOfHearts', 'Trix'
    this.roundNumber = 0; // 0..20
    this.turnPlayerIndex = 0;
    this.tableCards = []; // { playerIndex, card }
    this.lastTrick = []; // previous completed trick — { playerIndex, card }
    this.leadingSuit = null;
    
    this.trixTable = {
      Spades: { min: null, max: null },
      Hearts: { min: null, max: null },
      Diamonds: { min: null, max: null },
      Clubs: { min: null, max: null }
    };
    this.finishedPlayers = [];
    
    this.gamesPlayedByKing = [
      [], [], [], [] // 4 kings, each array stores game types selected
    ];
    this.roundPlayedCards = []; // public trick cards played this contract
    this.scores = players.map(() => 0);
  }

  isRoundOver() {
    if (this.currentGameType === 'Trix') {
      return this.finishedPlayers.length === 3 || this.finishedPlayers.length === 4;
    }
    if (this.currentGameType === 'Queens') {
      const totalQueensTaken = this.players.reduce(
        (sum, p) => sum + p.takenCards.filter(c => c.rank === 'Q').length,
        0
      );
      if (totalQueensTaken >= 4) return true;
    } else if (this.currentGameType === 'KingOfHearts') {
      const kingTaken = this.players.some(p =>
        p.takenCards.some(c => c.rank === 'K' && c.suit === 'Hearts')
      );
      if (kingTaken) return true;
    } else if (this.currentGameType === 'Diamonds') {
      const totalDiamondsTaken = this.players.reduce(
        (sum, p) => sum + p.takenCards.filter(c => c.suit === 'Diamonds').length,
        0
      );
      if (totalDiamondsTaken >= 13) return true;
    }
    return this.players.every(p => p.hand.length === 0);
  }
}

module.exports = GameState;
