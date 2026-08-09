/**
 * Trix scoring (committed into cumulative `gameState.scores` at round end):
 *   Diamonds      → −10 per diamond taken
 *   Tricks         → −15 per trick taken
 *   Queens         → −25 per queen taken
 *   KingOfHearts   → −75 for taking K♥
 *   Trix           → +200 / +150 / +100 / +50 by finish order
 *
 * All deltas are multiples of 5; cumulative totals must stay multiples of 5.
 */
class ScoreManager {
  static POINTS = Object.freeze({
    diamond: 10,
    trick: 15,
    queen: 25,
    kingOfHearts: 75,
    trixFinish: Object.freeze([200, 150, 100, 50]),
  });

  // Pure computation of the current contract's score delta per seat.
  // Does NOT mutate gameState — safe to call for live/preview display.
  static computeRoundScore(gameState) {
    const { currentGameType, players } = gameState;
    const scores = [0, 0, 0, 0];
    const P = ScoreManager.POINTS;

    if (currentGameType === 'Diamonds') {
      players.forEach((p, idx) => {
        const diamonds = p.takenCards.filter((c) => c.suit === 'Diamonds').length;
        scores[idx] -= diamonds * P.diamond;
      });
    } else if (currentGameType === 'Tricks') {
      players.forEach((p, idx) => {
        const tricks = Math.floor(p.takenCards.length / 4);
        scores[idx] -= tricks * P.trick;
      });
    } else if (currentGameType === 'Queens') {
      players.forEach((p, idx) => {
        const queens = p.takenCards.filter((c) => c.rank === 'Q').length;
        scores[idx] -= queens * P.queen;
      });
    } else if (currentGameType === 'KingOfHearts') {
      players.forEach((p, idx) => {
        const kingOfHearts = p.takenCards.filter(
          (c) => c.rank === 'K' && c.suit === 'Hearts'
        ).length;
        scores[idx] -= kingOfHearts * P.kingOfHearts;
      });
    } else if (currentGameType === 'Trix') {
      const tScores = P.trixFinish;
      gameState.finishedPlayers.forEach((pIdx, i) => {
        scores[pIdx] += tScores[i] || 0;
      });
    }

    return scores;
  }

  // Commits the round score to cumulative totals and returns the delta.
  // Idempotent: a second call in the same contract returns the stored delta.
  static calculateRoundScore(gameState) {
    if (gameState.roundScoreApplied) {
      return Array.isArray(gameState.lastRoundDelta)
        ? [...gameState.lastRoundDelta]
        : [0, 0, 0, 0];
    }

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

    gameState.lastRoundDelta = [...scores];
    gameState.roundScoreApplied = true;
    return scores;
  }

  static resetRoundScoreGate(gameState) {
    gameState.roundScoreApplied = false;
    gameState.lastRoundDelta = [0, 0, 0, 0];
  }
}

module.exports = ScoreManager;
