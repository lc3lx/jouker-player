class GameManager {
  static getValidCardsForTrick(hand, leadingSuit) {
    if (!leadingSuit) return hand;
    const sameSuit = hand.filter(c => c.suit === leadingSuit);
    return sameSuit.length > 0 ? sameSuit : hand;
  }

  static getValidCardsForTrix(hand, trixTable) {
    return hand.filter(card => {
      const suitStats = trixTable[card.suit];
      if (!suitStats) return false;

      const suitOpened = suitStats.min != null && suitStats.max != null;
      if (card.rank === 'J') {
        // In Trix, each suit starts with J, then expands up/down from it.
        return !suitOpened;
      }
      if (!suitOpened) return false;
      
      const val = card.value;
      if (val === suitStats.min - 1) return true;
      if (val === suitStats.max + 1) return true;
      return false;
    });
  }

  static getValidCards(gameState, playerIndex) {
    const player = gameState.players[playerIndex];
    if (gameState.finishedPlayers.includes(playerIndex)) return [];
    
    if (gameState.currentGameType === 'Trix') {
      return GameManager.getValidCardsForTrix(player.hand, gameState.trixTable);
    } else {
      return GameManager.getValidCardsForTrick(player.hand, gameState.leadingSuit);
    }
  }

  static playCard(gameState, playerIndex, cardData) {
    const player = gameState.players[playerIndex];
    if (gameState.turnPlayerIndex !== playerIndex) return { success: false, reason: 'Not your turn' };
    
    const cardStr = `${cardData.rank}${cardData.suit}`;
    const cardIndex = player.hand.findIndex(c => `${c.rank}${c.suit}` === cardStr);
    if (cardIndex === -1) return { success: false, reason: 'Card not in hand' };

    const validCards = GameManager.getValidCards(gameState, playerIndex);
    const isValid = validCards.some(c => `${c.rank}${c.suit}` === cardStr);
    if (!isValid) return { success: false, reason: 'Invalid card to play' };

    const card = player.hand[cardIndex];
    player.hand.splice(cardIndex, 1);

    if (gameState.currentGameType === 'Trix') {
      const suitStats = gameState.trixTable[card.suit];
      if (card.rank === 'J') {
        suitStats.min = 11;
        suitStats.max = 11;
      } else {
        if (card.value < suitStats.min) suitStats.min = card.value;
        if (card.value > suitStats.max) suitStats.max = card.value;
      }
      
      if (player.hand.length === 0) {
        if (!gameState.finishedPlayers.includes(playerIndex)) {
          gameState.finishedPlayers.push(playerIndex);
        }
      }
    } else {
      if (gameState.tableCards.length === 0) {
        gameState.leadingSuit = card.suit;
      }
      gameState.tableCards.push({ playerIndex, card });
      gameState.roundPlayedCards.push({ rank: card.rank, suit: card.suit });
    }

    return { success: true };
  }

  static resolveTrick(gameState) {
    if (gameState.currentGameType === 'Trix' || gameState.tableCards.length < 4) {
      return null;
    }
    
    let winnerIndex = -1;
    let highestValue = -1;
    const trickCards = [];
    
    for (const entry of gameState.tableCards) {
      trickCards.push(entry.card);
      if (entry.card.suit === gameState.leadingSuit) {
        if (entry.card.value > highestValue) {
          highestValue = entry.card.value;
          winnerIndex = entry.playerIndex;
        }
      }
    }
    
    const winner = gameState.players[winnerIndex];
    winner.takenCards.push(...trickCards);

    gameState.lastTrick = gameState.tableCards.map((entry) => ({
      playerIndex: entry.playerIndex,
      card: { rank: entry.card.rank, suit: entry.card.suit },
    }));

    gameState.tableCards = [];
    gameState.leadingSuit = null;
    gameState.turnPlayerIndex = winnerIndex;
    
    return { winnerIndex, trickCards };
  }

  static nextTurn(gameState) {
    if (gameState.currentGameType === 'Trix') {
        let attempts = 0;
        let nextIdx = gameState.turnPlayerIndex;
        do {
            nextIdx = (nextIdx + 1) % 4;
            attempts++;
            if (attempts > 4) break;
            
            if (gameState.finishedPlayers.includes(nextIdx)) continue;
            
            const valid = GameManager.getValidCards(gameState, nextIdx);
            if (valid.length > 0) {
               gameState.turnPlayerIndex = nextIdx;
               return;
            }
        } while (attempts <= 4);
    } else {
        if (gameState.tableCards.length > 0 && gameState.tableCards.length < 4) {
           gameState.turnPlayerIndex = (gameState.turnPlayerIndex + 1) % 4;
        }
    }
  }
}

module.exports = GameManager;
