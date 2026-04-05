class Player {
  constructor(id, name, isBot = false) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.hand = [];
    this.takenCards = [];
    this.score = 0;
    this.hasFinishedTrix = false;
  }

  resetForRound() {
    this.hand = [];
    this.takenCards = [];
    this.hasFinishedTrix = false;
  }
}

module.exports = Player;
