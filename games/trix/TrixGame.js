const BaseGame = require('../base/BaseGame');
const Player = require('./models/Player');
const GameState = require('./models/GameState');
const RoundManager = require('./managers/RoundManager');
const ScoreManager = require('./managers/ScoreManager');
const GameManager = require('./managers/GameManager');
const BotAI = require('./ai/BotAI');

class TrixGame extends BaseGame {
  constructor(roomId, options = {}) {
    super(roomId, 'trix', options);
    this.maxPlayers = 4;
    this.gameState = null;
    this.botInterval = null;
    this.onStateChanged = null;
    this.selectingStartedAt = 0;
    this.roundEndAt = 0;
  }

  setStateChangedListener(listener) {
    this.onStateChanged = typeof listener === "function" ? listener : null;
  }

  notifyStateChanged() {
    if (!this.onStateChanged) return;
    try {
      this.onStateChanged();
    } catch (e) {
      // ignore listener errors
    }
  }

  getRequiredPlayers() {
    // It can start with fewer humans because we fill with bots
    return 4;
  }

  /**
   * Sync lobby roster from Mongo table seats + active sockets. When game already started, only refreshes human socketIds.
   * @param {import('mongoose').Document} tableDoc - Table with seats.user populated
   * @param {(userIdStr: string) => string | null} resolveSocket
   */
  syncLobbyFromTable(tableDoc, resolveSocket) {
    if (this.gameState) {
      for (const p of this.players) {
        if (!p.isBot) {
          const sid = resolveSocket(String(p.userId));
          if (sid) p.socketId = sid;
        }
      }
      return;
    }

    this.players = [];
    for (let i = 0; i < tableDoc.seats.length; i++) {
      const seat = tableDoc.seats[i];
      const uid = seat.user && seat.user._id ? seat.user._id : seat.user;
      const uidStr = String(uid);
      let nm = `لاعب ${i + 1}`;
      if (seat.user && typeof seat.user === "object" && seat.user.name) {
        nm = String(seat.user.name);
      }
      this.players.push({
        userId: uid,
        socketId: resolveSocket(uidStr) || null,
        seatIndex: this.players.length,
        isBot: false,
        displayName: nm,
        chips: Number(seat.chips) || 0,
      });
    }
    let bi = 0;
    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${bi}_${Math.random().toString(36).substr(2, 9)}`;
      bi += 1;
      this.players.push({
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        isBot: true,
        displayName: "بوت",
        chips: 0,
      });
    }
  }

  startGame() {
    // Fill with bots if needed
    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      this.players.push({
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        isBot: true,
        displayName: "بوت",
        chips: 0,
      });
    }

    const gamePlayers = this.players.map(
      (p) =>
        new Player(
          p.userId,
          p.isBot
            ? p.displayName || `بوت ${p.seatIndex + 1}`
            : p.displayName || `لاعب ${p.seatIndex + 1}`,
          p.isBot
        )
    );
    this.gameState = new GameState(gamePlayers);
    
    this.startRound();
    this.startBotTimer();
    return true;
  }

  startRound() {
    this.state = 'selecting_game';
    this.selectingStartedAt = Date.now();
    this.roundEndAt = 0;
    this.gameState.deck.dealCardsToPlayers(this.gameState.players);
  }

  startBotTimer() {
    if (this.botInterval) clearInterval(this.botInterval);
    this.botInterval = setInterval(() => {
       this.checkBotTurn();
    }, 900);
  }

  checkBotTurn() {
    if (!this.gameState || this.isGameFinished()) return;
    let stateChanged = false;
    
    if (this.state === 'selecting_game') {
      const kingIndex = this.gameState.currentKingIndex;
      const king = this.gameState.players[kingIndex];
      const available = RoundManager.getAvailableGames(this.gameState, kingIndex);
      if (available.length > 0) {
        const timedOut = this.selectingStartedAt > 0 &&
          (Date.now() - this.selectingStartedAt) >= 15000;
        if (king.isBot || timedOut) {
           const gameType = king.isBot
             ? BotAI.botChooseGame(this.gameState, kingIndex, available)
             : available[0];
           const result = this.applyMove(kingIndex, 'select_game', { gameType });
           if (result && result.success) stateChanged = true;
        }
      }
    } else if (this.state === 'playing') {
       if (this.gameState.currentGameType === 'Trix') {
          const turnIndex = this.gameState.turnPlayerIndex;
          const valid = GameManager.getValidCards(this.gameState, turnIndex);
          if (valid.length === 0) {
             const before = this.gameState.turnPlayerIndex;
             GameManager.nextTurn(this.gameState);
             if (this.gameState.turnPlayerIndex !== before) {
                stateChanged = true;
             }
          }
       }

       const turnIndex = this.gameState.turnPlayerIndex;
       const player = this.gameState.players[turnIndex];
       if (player.isBot) {
          const valid = GameManager.getValidCards(this.gameState, turnIndex);
          if (valid.length > 0) {
              const card = BotAI.botChooseCard(this.gameState, turnIndex, valid);
              if (card) {
                  const result = this.applyMove(turnIndex, 'play_card', { card });
                  if (result && result.success) stateChanged = true;
              }
          } else {
              // Should auto skip if Trix. 
              // Wait, GameManager.nextTurn already handles skipping finished players,
              // but what if valid.length == 0 for a bot in Trix?
              // The nextTurn logic in Trix automatically skips players with 0 valid cards?
              // Let's explicitly pass turn for bot if Trix and no valid cards.
              if (this.gameState.currentGameType === 'Trix') {
                 const before = this.gameState.turnPlayerIndex;
                 GameManager.nextTurn(this.gameState);
                 if (this.gameState.turnPlayerIndex !== before) {
                    stateChanged = true;
                 }
              }
          }
       }
    } else if (this.state === 'round_end') {
       if (this.roundEndAt === 0) this.roundEndAt = Date.now();
       if ((Date.now() - this.roundEndAt) >= 1800) {
          const ok = this.nextRound();
          if (ok) stateChanged = true;
       }
    }

    if (stateChanged) {
      this.notifyStateChanged();
    }
  }

  getGameState(forPlayerIndex) {
    if (!this.gameState) return null;
    
    const hands = this.gameState.players.map((p, idx) => {
       if (idx === forPlayerIndex) return p.hand;
       return new Array(p.hand.length).fill(null); // hide opponent cards
    });

    const seatsPublic = this.gameState.players.map((gp, idx) => ({
      seatIndex: idx,
      displayName: gp.name,
      isBot: gp.isBot,
      chips: this.players[idx] ? this.players[idx].chips || 0 : 0,
    }));

    return {
      state: this.state,
      hands,
      tableCards: this.gameState.tableCards,
      scores: this.gameState.scores,
      turnPlayerIndex: this.gameState.turnPlayerIndex,
      currentKingIndex: this.gameState.currentKingIndex,
      currentGameType: this.gameState.currentGameType,
      roundNumber: this.gameState.roundNumber,
      gamesPlayedByKing: this.gameState.gamesPlayedByKing,
      trixTable: this.gameState.trixTable,
      finishedPlayers: this.gameState.finishedPlayers,
      validCards: this.state === 'playing' ? GameManager.getValidCards(this.gameState, forPlayerIndex) : [],
      seatsPublic,
    };
  }

  applyMove(playerIndex, action, payload) {
    if (this.state === 'selecting_game' && action === 'select_game') {
      if (this.gameState.currentKingIndex !== playerIndex) return { success: false, reason: 'Not king' };
      const { gameType } = payload;
      const ok = RoundManager.selectGame(this.gameState, gameType);
      if (!ok) return { success: false, reason: 'Invalid game selection' };
      this.state = 'playing';
      this.selectingStartedAt = 0;
      if (this.gameState.currentGameType === 'Trix') {
        const currentValid = GameManager.getValidCards(
          this.gameState,
          this.gameState.turnPlayerIndex
        );
        if (currentValid.length === 0) {
          GameManager.nextTurn(this.gameState);
        }
      }
      return { success: true };
    }

    if (this.state === 'playing' && action === 'play_card') {
       if (this.gameState.turnPlayerIndex !== playerIndex) return { success: false, reason: 'Not your turn' };
       const { card } = payload;
       const result = GameManager.playCard(this.gameState, playerIndex, card);
       if (!result.success) return result;

       const trickResult = GameManager.resolveTrick(this.gameState);
       
       if (this.gameState.isRoundOver()) {
          this.state = 'round_end';
          this.roundEndAt = Date.now();
          ScoreManager.calculateRoundScore(this.gameState);
          return { success: true, trickResult };
       }

       if (!trickResult && this.gameState.currentGameType === 'Trix') {
          // Find next player who can play
          GameManager.nextTurn(this.gameState);
          // If the player who just played finished his hand, we already added him to finishedPlayers internally
       } else if (!trickResult) {
          // Still in the middle of a trick
          this.gameState.turnPlayerIndex = (this.gameState.turnPlayerIndex + 1) % 4;
       }

       return { success: true, trickResult };
    }

    return { success: false, reason: 'Invalid action or state' };
  }

  nextRound() {
    if (this.state !== 'round_end') return false;
    this.roundEndAt = 0;
    
    // Check if game end
    if (this.gameState.roundNumber >= 20) {
       this.state = 'game_end';
       clearInterval(this.botInterval);
       return true;
    }

    // Advance king if 5 games played
    const kingIndex = this.gameState.currentKingIndex;
    if (this.gameState.gamesPlayedByKing[kingIndex].length === 5) {
       this.gameState.currentKingIndex = (kingIndex + 1) % 4;
    }

    this.gameState.players.forEach(p => p.resetForRound());
    this.startRound();
    return true;
  }

  getRoundResult() {
     return { scores: this.gameState.scores, finishedPlayers: this.gameState.finishedPlayers };
  }

  getGameResult() {
     let winnerIndex = 0;
     let maxScore = -Infinity;
     this.gameState.scores.forEach((s, i) => {
        if (s > maxScore) { maxScore = s; winnerIndex = i; }
     });
     return { winnerIndex, scores: this.gameState.scores };
  }
}

module.exports = TrixGame;

