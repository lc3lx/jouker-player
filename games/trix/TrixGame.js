const BaseGameEngine = require('../../engine/BaseGameEngine');
const crypto = require('crypto');
const Player = require('./models/Player');
const GameState = require('./models/GameState');
const RoundManager = require('./managers/RoundManager');
const ScoreManager = require('./managers/ScoreManager');
const GameManager = require('./managers/GameManager');
const BotAI = require('./ai/BotAI');
const timerManager = require('../../engine/TimerManager');
const StateMachine = require('../../engine/StateMachine');
const { STATE: TRIX_STATE, TRANSITIONS: TRIX_TRANSITIONS } = require('../../engine/states/trixStates');
const {
  resolveProfileOnlyCosmeticsForSeats,
  publicCosmeticsPayload,
  emptyCosmetics,
} = require('../../services/playerPublicCosmeticsService');

function clearManagedOrNativeInterval(id) {
  if (!timerManager.clear(id)) clearInterval(id);
}

const ACTIVE_STATES = new Set(['selecting_game', 'playing', 'round_end', 'game_end']);

function parseTurnTimeoutSeconds() {
  const n = parseInt(process.env.TURN_TIMEOUT_SECONDS || '30', 10);
  if (!Number.isFinite(n) || n < 5) return 30;
  return Math.min(n, 120);
}

function parseSelectTimeoutSeconds() {
  const n = parseInt(process.env.TRIX_SELECT_TIMEOUT_SECONDS || '15', 10);
  if (!Number.isFinite(n) || n < 5) return 15;
  return Math.min(n, 120);
}

class TrixGame extends BaseGameEngine {
  constructor(roomId, options = {}) {
    super(roomId, 'trix', options);
    this.maxPlayers = 4;
    this.gameState = null;
    this._fsm = new StateMachine(this.state, TRIX_TRANSITIONS, {
      onIllegal: (from, to) => {
        console.warn(`[TrixGame:${this.roomId}] FSM observed unexpected transition: ${from} -> ${to}`);
        return true; // mirror stays in sync with the authoritative this.state string
      },
    });
    this.botInterval = null;
    this.onStateChanged = null;
    this.onGameEvent = null;
    this.onAfterMove = null;
    this.selectingStartedAt = 0;
    this.roundEndAt = 0;
    this.turnTimerInterval = null;
    this.turnTimerEndsAt = null;
    this.turnTimerPhase = null;
    this.turnTimerSeconds = parseTurnTimeoutSeconds();
    this.selectTimeoutSeconds = parseSelectTimeoutSeconds();
    this.processedMoveIds = new Set();
    this._settlementTriggered = false;
    this._lastSettlementPayload = null;
    this._finishedAt = null;
    this._settlementCompleted = false;
  }

  setStateChangedListener(listener) {
    this.onStateChanged = typeof listener === 'function' ? listener : null;
  }

  setGameEventListener(listener) {
    this.onGameEvent = typeof listener === 'function' ? listener : null;
  }

  setAfterMoveListener(listener) {
    this.onAfterMove = typeof listener === 'function' ? listener : null;
  }

  notifyStateChanged() {
    if (!this.onStateChanged) return;
    try {
      this.onStateChanged();
    } catch (e) {
      // ignore listener errors
    }
  }

  _emit(event, payload) {
    if (!this.onGameEvent) return;
    try {
      this.onGameEvent(event, payload);
    } catch (e) {
      // ignore listener errors
    }
  }

  _notifyAfterMove(result) {
    if (!result?.success || !this.onAfterMove) return;
    try {
      this.onAfterMove(result);
    } catch (e) {
      // ignore listener errors
    }
  }

  _checkDuplicateMove(playerIndex, action, payload) {
    const moveId = payload && payload.moveId;
    if (!moveId) return null;
    const key = `${playerIndex}:${action}:${moveId}`;
    if (this.processedMoveIds.has(key)) {
      return { success: true, duplicate: true };
    }
    this.processedMoveIds.add(key);
    if (this.processedMoveIds.size > 500) {
      this.processedMoveIds = new Set(Array.from(this.processedMoveIds).slice(-250));
    }
    return null;
  }

  getRequiredPlayers() {
    return 4;
  }

  needsInitialDeal() {
    return !this.gameState;
  }

  clearBotTimer() {
    if (this.botInterval != null) {
      clearManagedOrNativeInterval(this.botInterval);
      this.botInterval = null;
    }
  }

  clearTurnTimer() {
    if (this.turnTimerInterval != null) {
      clearManagedOrNativeInterval(this.turnTimerInterval);
      this.turnTimerInterval = null;
    }
    this.turnTimerEndsAt = null;
    this.turnTimerPhase = null;
  }

  destroy() {
    this.clearBotTimer();
    this.clearTurnTimer();
    timerManager.clearAll(this.roomId);
    this.onStateChanged = null;
    this.onGameEvent = null;
    this.onAfterMove = null;
  }

  _remainingTurnSeconds() {
    if (!this.turnTimerEndsAt) return 0;
    return Math.max(0, Math.ceil((this.turnTimerEndsAt - Date.now()) / 1000));
  }

  _turnTimerPayload(extra = {}) {
    const playerIndex =
      this.state === 'selecting_game'
        ? this.gameState?.currentKingIndex
        : this.gameState?.turnPlayerIndex;
    return {
      phase: this.turnTimerPhase,
      playerIndex,
      remainingSeconds: this._remainingTurnSeconds(),
      ...extra,
    };
  }

  _emitTurnTimerStarted() {
    this._emit('turn_timer_started', this._turnTimerPayload());
  }

  _emitTurnTimerUpdate() {
    this._emit('turn_timer_update', this._turnTimerPayload());
  }

  _tickTurnTimer() {
    if (!ACTIVE_STATES.has(this.state) || this.state === 'round_end' || this.state === 'game_end') {
      this.clearTurnTimer();
      return;
    }
    this._emitTurnTimerUpdate();
    if (this._remainingTurnSeconds() <= 0) {
      this.clearTurnTimer();
      this._handleTurnTimeout();
    }
  }

  _restartTurnTimer() {
    this.clearTurnTimer();
    if (!this.gameState || this.state === 'round_end' || this.state === 'game_end') return;

    if (this.state === 'selecting_game') {
      this.turnTimerPhase = 'selecting_game';
      this.turnTimerEndsAt = Date.now() + this.selectTimeoutSeconds * 1000;
    } else if (this.state === 'playing') {
      const idx = this.gameState.turnPlayerIndex;
      const player = this.gameState.players[idx];
      if (!player || player.isBot) return;
      const valid = GameManager.getValidCards(this.gameState, idx);
      if (this.gameState.currentGameType === 'Trix' && valid.length === 0) return;
      this.turnTimerPhase = 'playing';
      this.turnTimerEndsAt = Date.now() + this.turnTimerSeconds * 1000;
    } else {
      return;
    }

    this._emitTurnTimerStarted();
    this.turnTimerInterval = timerManager.schedule(this.roomId, 'turn', 1000, () => this._tickTurnTimer(), {
      repeat: true,
    });
  }

  _pickAutoPlayCard(playerIndex) {
    const valid = GameManager.getValidCards(this.gameState, playerIndex);
    if (valid.length === 0) return null;
    if (this.gameState.currentGameType === 'Trix') {
      const jacks = valid.filter((c) => c.rank === 'J');
      return jacks.length > 0 ? jacks[0] : valid[0];
    }
    const sorted = [...valid].sort((a, b) => a.value - b.value);
    return sorted[0];
  }

  _handleTurnTimeout() {
    if (!this.gameState) return;
    this._emit('turn_timer_expired', this._turnTimerPayload({ auto: true }));

    if (this.state === 'selecting_game') {
      const kingIndex = this.gameState.currentKingIndex;
      const available = RoundManager.getAvailableGames(this.gameState, kingIndex);
      if (available.length === 0) return;
      const result = this.applyMove(kingIndex, 'select_game', {
        gameType: available[0],
        fromTimeout: true,
        moveId: `timeout_select_${Date.now()}_${kingIndex}`,
      });
      if (result?.success && !result.duplicate) {
        this.notifyStateChanged();
      }
      return;
    }

    if (this.state === 'playing') {
      const idx = this.gameState.turnPlayerIndex;
      const player = this.gameState.players[idx];
      if (!player || player.isBot) return;
      const card = this._pickAutoPlayCard(idx);
      if (!card) {
        if (this.gameState.currentGameType === 'Trix') {
          const before = this.gameState.turnPlayerIndex;
          GameManager.nextTurn(this.gameState);
          if (this.gameState.turnPlayerIndex !== before) {
            this._restartTurnTimer();
            this.notifyStateChanged();
          }
        }
        return;
      }
      const result = this.applyMove(idx, 'play_card', {
        card: { rank: card.rank, suit: card.suit },
        fromTimeout: true,
        moveId: `timeout_play_${Date.now()}_${idx}`,
      });
      if (result?.success && !result.duplicate) {
        this.notifyStateChanged();
      }
    }
  }

  /**
   * Sync lobby roster from Mongo table seats + active sockets.
   */
  humanCount() {
    return this.players.filter((p) => !p.isBot).length;
  }

  convertHumanToBot(userId) {
    const p = this.players.find(
      (x) => !x.isBot && x.userId && String(x.userId) === String(userId)
    );
    if (!p) return false;
    p.vacatedFromUserId = String(userId);
    p.isBot = true;
    p.userId = `bot_vacate_${Date.now()}_${p.seatIndex ?? 0}`;
    p.socketId = null;
    p.displayName = "بوت";
    p.reconnectDeadline = null;
    p.cosmetics = emptyCosmetics();
    p.vipLevel = null;
    return true;
  }

  async restoreHumanAtSeat(seatIndex, userId, socketId, displayName) {
    return this.replaceBotWithHuman(seatIndex, userId, socketId, displayName, {
      allowTakeover: false,
    });
  }

  async replaceBotWithHuman(seatIndex, userId, socketId, displayName, opts = {}) {
    const p = this.players.find((x) => x.seatIndex === seatIndex);
    if (!p || !p.isBot) return false;

    const uid = String(userId);
    const allowTakeover = !!opts.allowTakeover;
    if (
      !allowTakeover &&
      p.vacatedFromUserId &&
      String(p.vacatedFromUserId) !== uid
    ) {
      return false;
    }

    p.isBot = false;
    p.userId = userId;
    p.socketId = socketId || null;
    p.displayName = displayName || p.displayName || `لاعب ${seatIndex + 1}`;
    if (opts.chips != null) p.chips = opts.chips;
    p.reconnectDeadline = null;
    delete p.vacatedFromUserId;

    if (
      (this.state === "selecting_game" || this.state === "playing") &&
      this.gameState
    ) {
      const activeIdx =
        this.state === "selecting_game"
          ? this.gameState.currentKingIndex
          : this.gameState.turnPlayerIndex;
      if (activeIdx === seatIndex) {
        this._restartTurnTimer();
      }
    }
    await this.applyCosmeticsToPlayers();
    return true;
  }

  async syncLobbyFromTable(tableDoc, resolveSocket) {
    if (this.gameState && ACTIVE_STATES.has(this.state)) {
      for (const p of this.players) {
        if (!p.isBot) {
          const sid = resolveSocket(String(p.userId));
          if (sid) p.socketId = sid;
        }
      }
      await this.applyCosmeticsToPlayers();
      return;
    }

    this.players = [];
    for (let i = 0; i < tableDoc.seats.length; i++) {
      const seat = tableDoc.seats[i];
      const uid = seat.user && seat.user._id ? seat.user._id : seat.user;
      const uidStr = String(uid);
      let nm = `لاعب ${i + 1}`;
      let avatar = null;
      if (seat.user && typeof seat.user === 'object') {
        if (seat.user.name) nm = String(seat.user.name);
        avatar = seat.user.profileImg || null;
      }
      this.players.push({
        userId: uid,
        socketId: resolveSocket(uidStr) || null,
        seatIndex: this.players.length,
        isBot: false,
        displayName: nm,
        avatar,
        chips: Number(seat.chips) || 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
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
        displayName: 'بوت',
        avatar: null,
        chips: 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
      });
    }
    await this.applyCosmeticsToPlayers();
  }

  /**
   * Resolve store skin + VIP table/card overrides for all human players and
   * cache the result on each lobby row. Call after roster changes (join,
   * bot-replace, syncLobbyFromTable) before building outgoing state.
   */
  async applyCosmeticsToPlayers() {
    const seatsForResolve = this.players.map((p) => ({
      userId: p.userId,
      isBot: !!p.isBot,
    }));
    const map = await resolveProfileOnlyCosmeticsForSeats(seatsForResolve);
    for (const p of this.players) {
      if (p.isBot || !p.userId) {
        p.cosmetics = emptyCosmetics();
        p.vipLevel = null;
        continue;
      }
      const row = map.get(String(p.userId));
      p.vipLevel = row?.vipLevel || null;
      p.cosmetics = row?.cosmetics ? { ...row.cosmetics } : emptyCosmetics();
    }
  }

  async startGame() {
    this.sessionId = crypto.randomUUID();
    this._settlementTriggered = false;
    this._lastSettlementPayload = null;
    this._finishedAt = null;
    this._settlementCompleted = false;
    this.processedMoveIds = new Set();

    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      this.players.push({
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        isBot: true,
        displayName: 'بوت',
        chips: 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
      });
    }

    await this.applyCosmeticsToPlayers();

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
    this._notifyAfterMove({ success: true, gameStarted: true });
    return true;
  }

  _assignKingBySevenOfHearts() {
    if (!this.gameState) return;
    for (let i = 0; i < this.gameState.players.length; i++) {
      const hasSeven = this.gameState.players[i].hand.some(
        (c) => c.suit === 'Hearts' && c.rank === '7'
      );
      if (hasSeven) {
        this.gameState.currentKingIndex = i;
        return;
      }
    }
  }

  startRound() {
    this.state = 'selecting_game';
    this._fsm.transition(TRIX_STATE.SELECTING_GAME);
    this.selectingStartedAt = Date.now();
    this.roundEndAt = 0;
    this.gameState.deck.dealCardsToPlayers(this.gameState.players);
    const isFirstDeal =
      this.gameState.roundNumber === 0 &&
      this.gameState.gamesPlayedByKing.every((row) => row.length === 0);
    if (isFirstDeal) {
      this._assignKingBySevenOfHearts();
    }
    this._restartTurnTimer();
  }

  startBotTimer() {
    if (this.botInterval != null) clearManagedOrNativeInterval(this.botInterval);
    this.botInterval = timerManager.schedule(
      this.roomId,
      'bot',
      900,
      () => {
        this.checkBotTurn();
      },
      { repeat: true }
    );
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
          (Date.now() - this.selectingStartedAt) >= this.selectTimeoutSeconds * 1000;
        if (king.isBot || timedOut) {
          const gameType = king.isBot
            ? BotAI.botChooseGame(this.gameState, kingIndex, available)
            : available[0];
          const result = this.applyMove(kingIndex, 'select_game', {
            gameType,
            moveId: `bot_select_${Date.now()}_${kingIndex}`,
          });
          if (result && result.success && !result.duplicate) stateChanged = true;
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
            this._restartTurnTimer();
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
            const result = this.applyMove(turnIndex, 'play_card', {
              card,
              moveId: `bot_play_${Date.now()}_${turnIndex}`,
            });
            if (result && result.success && !result.duplicate) stateChanged = true;
          }
        } else if (this.gameState.currentGameType === 'Trix') {
          const before = this.gameState.turnPlayerIndex;
          GameManager.nextTurn(this.gameState);
          if (this.gameState.turnPlayerIndex !== before) {
            stateChanged = true;
            this._restartTurnTimer();
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
      if (idx === forPlayerIndex) return p.hand.map((c) => ({ rank: c.rank, suit: c.suit }));
      return new Array(p.hand.length).fill(null);
    });

    const seatsPublic = this.gameState.players.map((gp, idx) => {
      const lobby = this.players[idx];
      const deadline = lobby?.reconnectDeadline;
      return {
        seatIndex: idx,
        displayName: gp.name,
        avatar: lobby?.avatar || null,
        userId: lobby && !lobby.isBot ? lobby.userId || null : null,
        isBot: gp.isBot,
        chips: lobby ? lobby.chips || 0 : 0,
        vacatingUntil:
          deadline && deadline > Date.now() ? deadline : null,
        vipLevel: lobby?.vipLevel || null,
        cosmetics: publicCosmeticsPayload(lobby?.cosmetics),
      };
    });

    return {
      state: this.state,
      sessionId: this.sessionId,
      hands,
      tableCards: this.gameState.tableCards.map((entry) => ({
        playerIndex: entry.playerIndex,
        card: { rank: entry.card.rank, suit: entry.card.suit },
      })),
      lastTrick: (this.gameState.lastTrick || []).map((entry) => ({
        playerIndex: entry.playerIndex,
        card: { rank: entry.card.rank, suit: entry.card.suit },
      })),
      scores: [...this.gameState.scores],
      turnPlayerIndex: this.gameState.turnPlayerIndex,
      currentKingIndex: this.gameState.currentKingIndex,
      currentGameType: this.gameState.currentGameType,
      roundNumber: this.gameState.roundNumber,
      gamesPlayedByKing: this.gameState.gamesPlayedByKing.map((row) => [...row]),
      trixTable: JSON.parse(JSON.stringify(this.gameState.trixTable)),
      finishedPlayers: [...this.gameState.finishedPlayers],
      roundPlayedCards: (this.gameState.roundPlayedCards || []).map((c) => ({
        rank: c.rank,
        suit: c.suit,
      })),
      tricksTakenThisRound:
        forPlayerIndex >= 0 && forPlayerIndex < this.gameState.players.length
          ? Math.floor(
              this.gameState.players[forPlayerIndex].takenCards.length / 4
            )
          : 0,
      // Provisional score for the CURRENT contract per seat (public).
      // Resets each contract; added to cumulative `scores` at round end.
      roundScores:
        this.gameState.currentGameType &&
        (this.state === 'playing' || this.state === 'round_end')
          ? ScoreManager.computeRoundScore(this.gameState)
          : [0, 0, 0, 0],
      validCards:
        this.state === 'playing' &&
        forPlayerIndex === this.gameState.turnPlayerIndex
          ? GameManager.getValidCards(this.gameState, forPlayerIndex).map((c) => ({
              rank: c.rank,
              suit: c.suit,
            }))
          : [],
      seatsPublic,
      turnTimer: this.turnTimerEndsAt
        ? {
            phase: this.turnTimerPhase,
            playerIndex:
              this.turnTimerPhase === 'selecting_game'
                ? this.gameState.currentKingIndex
                : this.gameState.turnPlayerIndex,
            remainingSeconds: this._remainingTurnSeconds(),
          }
        : null,
    };
  }

  applyMove(playerIndex, action, payload) {
    const dup = this._checkDuplicateMove(playerIndex, action, payload);
    if (dup) {
      this._notifyAfterMove(dup);
      return dup;
    }

    if (this.state === 'selecting_game' && action === 'select_game') {
      if (this.gameState.currentKingIndex !== playerIndex) {
        return { success: false, reason: 'Not king' };
      }
      const { gameType } = payload;
      const ok = RoundManager.selectGame(this.gameState, gameType);
      if (!ok) return { success: false, reason: 'Invalid game selection' };
      this.state = 'playing';
      this._fsm.transition(TRIX_STATE.PLAYING);
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
      this._restartTurnTimer();
      const result = { success: true, gameTypeSelected: true };
      this._notifyAfterMove(result);
      return result;
    }

    if (this.state === 'playing' && action === 'play_card') {
      if (this.gameState.turnPlayerIndex !== playerIndex) {
        return { success: false, reason: 'Not your turn' };
      }
      const { card } = payload;
      const result = GameManager.playCard(this.gameState, playerIndex, card);
      if (!result.success) return result;

      const trickResult = GameManager.resolveTrick(this.gameState);
      let roundEnded = false;

      if (this.gameState.isRoundOver()) {
        this.state = 'round_end';
        this._fsm.transition(TRIX_STATE.ROUND_END);
        this.roundEndAt = Date.now();
        ScoreManager.calculateRoundScore(this.gameState);
        roundEnded = true;
        this.clearTurnTimer();
      } else if (!trickResult && this.gameState.currentGameType === 'Trix') {
        GameManager.nextTurn(this.gameState);
        this._restartTurnTimer();
      } else if (!trickResult) {
        this.gameState.turnPlayerIndex = (this.gameState.turnPlayerIndex + 1) % 4;
        this._restartTurnTimer();
      } else {
        this._restartTurnTimer();
      }

      const moveResult = { success: true, trickResult, roundEnded };
      this._notifyAfterMove(moveResult);
      return moveResult;
    }

    return { success: false, reason: 'Invalid action or state' };
  }

  nextRound() {
    if (this.state !== 'round_end') return false;
    this.roundEndAt = 0;

    if (this.gameState.roundNumber >= 20) {
      this.state = 'game_end';
      this._fsm.transition(TRIX_STATE.GAME_END);
      this.clearBotTimer();
      this.clearTurnTimer();
      if (!this._finishedAt) this._finishedAt = Date.now();
      this._notifyAfterMove({ success: true, gameEnded: true });
      return true;
    }

    const kingIndex = this.gameState.currentKingIndex;
    if (this.gameState.gamesPlayedByKing[kingIndex].length === 5) {
      this.gameState.currentKingIndex = (kingIndex + 1) % 4;
    }

    this.gameState.players.forEach((p) => p.resetForRound());
    this.startRound();
    this._notifyAfterMove({ success: true, roundAdvanced: true });
    return true;
  }

  getRoundResult() {
    return {
      scores: [...this.gameState.scores],
      finishedPlayers: [...this.gameState.finishedPlayers],
    };
  }

  getGameResult() {
    let winnerIndex = 0;
    let maxScore = -Infinity;
    this.gameState.scores.forEach((s, i) => {
      if (s > maxScore) {
        maxScore = s;
        winnerIndex = i;
      }
    });
    return { winnerIndex, scores: [...this.gameState.scores] };
  }
}

module.exports = TrixGame;
