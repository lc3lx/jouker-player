class RoundManager {
  static getAvailableGames(gameState, kingIndex) {
    const allGames = ['Diamonds', 'Tricks', 'Queens', 'KingOfHearts', 'Trix'];
    const played = gameState.gamesPlayedByKing[kingIndex];
    return allGames.filter(g => !played.includes(g));
  }

  static selectGame(gameState, gameType) {
    const kingIndex = gameState.currentKingIndex;
    const available = RoundManager.getAvailableGames(gameState, kingIndex);
    if (!available.includes(gameType)) return false;
    
    gameState.gamesPlayedByKing[kingIndex].push(gameType);
    gameState.currentGameType = gameType;
    gameState.turnPlayerIndex = kingIndex;
    
    gameState.tableCards = [];
    gameState.lastTrick = [];
    gameState.leadingSuit = null;
    gameState.finishedPlayers = [];
    gameState.trixTable = {
      Spades: { min: null, max: null },
      Hearts: { min: null, max: null },
      Diamonds: { min: null, max: null },
      Clubs: { min: null, max: null }
    };
    gameState.roundNumber++;
    return true;
  }
}

module.exports = RoundManager;
