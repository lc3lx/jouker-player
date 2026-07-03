class ScoreManager {
  // Pure computation of the current contract's score delta per seat.
  // Does NOT mutate gameState — safe to call for live/preview display.
  static computeRoundScore(gameState) {
    const { currentGameType, players } = gameState;
    const scores = [0, 0, 0, 0];

    if (currentGameType === 'Diamonds') {
      players.forEach((p, idx) => {
        const diamonds = p.takenCards.filter((c) => c.suit === 'Diamonds').length;
        scores[idx] -= diamonds * 10;
      });
    } else if (currentGameType === 'Tricks') {
      players.forEach((p, idx) => {
        const tricks = Math.floor(p.takenCards.length / 4);
        scores[idx] -= tricks * 15;
      });
    } else if (currentGameType === 'Queens') {
      players.forEach((p, idx) => {
        const queens = p.takenCards.filter((c) => c.rank === 'Q').length;
        scores[idx] -= queens * 25;
      });
    } else if (currentGameType === 'KingOfHearts') {
      players.forEach((p, idx) => {
        const kingOfHearts = p.takenCards.filter(
          (c) => c.rank === 'K' && c.suit === 'Hearts'
        ).length;
        scores[idx] -= kingOfHearts * 75;
      });
    } else if (currentGameType === 'Trix') {
      const tScores = [200, 150, 100, 50];
      gameState.finishedPlayers.forEach((pIdx, i) => {
        scores[pIdx] += tScores[i] || 0;
      });
    }

    return scores;
  }

  // Commits the round score to cumulative totals and returns the delta.
  static calculateRoundScore(gameState) {
    if (gameState.currentGameType === 'Trix') {
      // When only 3 players finished, the remaining player takes 4th place.
      if (gameState.finishedPlayers.length === 3) {
        const lastPlayerIndex = [0, 1, 2, 3].find(
          (idx) => !gameState.finishedPlayers.includes(idx)
        );
        if (lastPlayerIndex !== undefined) {
          gameState.finishedPlayers.push(lastPlayerIndex);
        }
      }
    }

    const scores = ScoreManager.computeRoundScore(gameState);

    scores.forEach((s, idx) => {
      gameState.players[idx].score += s;
      gameState.scores[idx] += s;
    });

    return scores;
  }
}

module.exports = ScoreManager;
