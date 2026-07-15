/**
 * Tarneeb Syrian 41 — table-based game (Mongo seats + bots).
 * Play order between tricks: clockwise (index + 1) % 4.
 */
const BaseGameEngine = require("../../engine/BaseGameEngine");
const crypto = require("crypto");
const { newDeck, shuffle } = require("../utils/cards");
const rules = require("./tarneeb41.rules");
const { GAME_START_COUNTDOWN_SECONDS, TRICK_DISPLAY_MS } = require("./tarneeb41.constants");
const TarneebBot = require("../../engine/bots/TarneebBot");
const timerManager = require("../../engine/TimerManager");
const StateMachine = require("../../engine/StateMachine");
const { STATE: T41_STATE, TRANSITIONS: T41_TRANSITIONS } = require("../../engine/states/tarneeb41States");
const {
  resolveProfileOnlyCosmeticsForSeats,
  publicCosmeticsPayload,
  emptyCosmetics,
} = require("../../services/playerPublicCosmeticsService");

/**
 * Try timerManager first; if id not found there (e.g. a native Interval from a
 * test helper that bypassed the scheduler), fall back to native clearInterval.
 */
function clearManagedOrNativeInterval(id) {
  if (!timerManager.clear(id)) clearInterval(id);
}

const ACTIVE_STATES = new Set(["bidding_syrian", "playing", "round_end", "game_end", "countdown"]);

function parseTurnTimeoutSeconds() {
  const n = parseInt(process.env.TURN_TIMEOUT_SECONDS || "30", 10);
  if (!Number.isFinite(n) || n < 5) return 30;
  return Math.min(n, 120);
}

class Tarneeb41Game extends BaseGameEngine {
  constructor(roomId, options = {}) {
    super(roomId, "tarneeb41", options);
    this.maxPlayers = 4;
    this.hands = [[], [], [], []];
    this.dealerIndex = -1;
    this.revealedCard = null;
    this.trump = null;
    this.declaredBids = [null, null, null, null];
    this.tricksThisRound = [0, 0, 0, 0];
    this.playerScores = [0, 0, 0, 0];
    this.trick = [];
    this.lastTrick = [];
    this.ledSuit = null;
    this.currentPlayerIndex = 0;
    this.trickLeader = 0;
    this.roundNumber = 0;
    this.botInterval = null;
    this.turnTimerInterval = null;
    this.turnTimerSeconds = parseTurnTimeoutSeconds();
    this.turnTimerEndsAt = null;
    this.turnTimerPhase = null;
    this.processedMoveIds = new Set();
    this.onGameEvent = null;
    this.onAfterMove = null;
    this.state = "waiting";
    this.countdownSeconds = null;
    this.countdownInterval = null;
    this._countdownStartGate = null;
    this.trickResolving = false;
    this.pendingTrickWinner = null;
    this.trickResolveTimer = null;
    this.trickResolveEndsAt = null;
    this._lastSettlementPayload = null;
    this._lastSettlementFailure = null;
    this._settlementTriggered = false;
    this._fsm = new StateMachine(this.state, T41_TRANSITIONS, {
      onIllegal: (from, to) => {
        console.warn(`[Tarneeb41Game:${this.roomId}] FSM observed unexpected transition: ${from} -> ${to}`);
        return true; // mirror stays in sync with the authoritative this.state string
      },
    });
  }

  humanCount() {
    return this.players.filter((p) => !p.isBot && p.userId != null).length;
  }

  isReadyForCountdown() {
    return (
      this.state === "waiting" &&
      this.players.length === 4 &&
      this.humanCount() === 4
    );
  }

  isCountdownActive() {
    return this.state === "countdown" && this.countdownInterval != null;
  }

  getRequiredPlayers() {
    return 4;
  }

  needsInitialDeal() {
    return this.state === "waiting";
  }

  setGameEventListener(listener) {
    this.onGameEvent = typeof listener === "function" ? listener : null;
  }

  setAfterMoveListener(listener) {
    this.onAfterMove = typeof listener === "function" ? listener : null;
  }

  _notifyAfterMove(result) {
    if (!result?.success || !this.onAfterMove) return;
    try {
      this.onAfterMove(result);
    } catch (_) {
      // ignore listener errors
    }
  }

  _emit(event, payload) {
    if (!this.onGameEvent) return;
    try {
      this.onGameEvent(event, payload);
    } catch (_) {
      // ignore listener errors
    }
  }

  /** Next seat in play/bidding order (clockwise). */
  nextSeat(i) {
    return (i + 1) % 4;
  }

  nextSeatCCW(i) {
    return (i + 3) % 4;
  }

  nextSeatCW(i) {
    return (i + 1) % 4;
  }

  setCountdownStartGate(gateFn) {
    this._countdownStartGate = typeof gateFn === "function" ? gateFn : null;
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

  /** Restore a human who was replaced by a vacate-bot at the same Mongo seat index. */
  async restoreHumanAtSeat(seatIndex, userId, socketId, displayName) {
    return this.replaceBotWithHuman(seatIndex, userId, socketId, displayName, {
      allowTakeover: false,
    });
  }

  /**
   * Replace a bot at [seatIndex] with a human.
   * @param {object} [opts]
   * @param {number} [opts.chips]
   * @param {boolean} [opts.allowTakeover] — false: only vacatedFromUserId may return
   */
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
      (this.state === "bidding_syrian" || this.state === "playing") &&
      this.currentPlayerIndex === seatIndex
    ) {
      this.startTurnTimer();
    }
    await this.applyCosmeticsToPlayers();
    return true;
  }

  async syncLobbyFromTable(tableDoc, resolveSocket) {
    if (ACTIVE_STATES.has(this.state) && this.players.length > 0) {
      for (const p of this.players) {
        if (!p.isBot) {
          const sid = resolveSocket(String(p.userId));
          p.socketId = sid || null;
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
      if (seat.user && typeof seat.user === "object") {
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

  startGameCountdown() {
    if (!this.isReadyForCountdown()) return false;
    if (this.isCountdownActive()) return false;
    this.clearCountdown();
    this.state = "countdown";
    this._fsm.transition(T41_STATE.COUNTDOWN);
    this.countdownSeconds = GAME_START_COUNTDOWN_SECONDS;
    this._emit("game_start_countdown", { remainingSeconds: this.countdownSeconds });
    this.countdownInterval = timerManager.schedule(
      this.roomId,
      "countdown",
      1000,
      () => {
        this.countdownSeconds -= 1;
        if (this.countdownSeconds <= 0) {
          void this._onCountdownElapsed();
          return;
        }
        this._emit("game_start_countdown", { remainingSeconds: this.countdownSeconds });
      },
      { repeat: true }
    );
    return true;
  }

  async _onCountdownElapsed() {
    this.clearCountdown();
    if (this._countdownStartGate) {
      try {
        const ok = await this._countdownStartGate();
        if (!ok) {
          this.state = "waiting";
          this._fsm.transition(T41_STATE.WAITING);
          this._emit("game_start_countdown_cancelled", { reason: "validation_failed" });
          return;
        }
      } catch (_) {
        this.state = "waiting";
        this._fsm.transition(T41_STATE.WAITING);
        this._emit("game_start_countdown_cancelled", { reason: "validation_error" });
        return;
      }
    } else if (!this.isReadyForCountdown()) {
      this.state = "waiting";
      this._fsm.transition(T41_STATE.WAITING);
      this._emit("game_start_countdown_cancelled", { reason: "not_ready" });
      return;
    }

    const started = await this.startGame();
    if (started) {
      this._notifyAfterMove({ success: true, gameStarted: true });
    } else {
      this.state = "waiting";
      this._fsm.transition(T41_STATE.WAITING);
      this._emit("game_start_countdown_cancelled", { reason: "start_failed" });
    }
  }

  cancelGameCountdown(reason = "cancelled") {
    if (this.state !== "countdown" && !this.countdownInterval) return false;
    this.clearCountdown();
    this.state = "waiting";
    this._fsm.transition(T41_STATE.WAITING);
    this._emit("game_start_countdown_cancelled", { reason });
    return true;
  }

  clearCountdown() {
    if (this.countdownInterval) {
      timerManager.clear(this.countdownInterval);
      this.countdownInterval = null;
    }
    this.countdownSeconds = null;
  }

  async startGame() {
    if (this.state !== "waiting" && this.state !== "countdown") return false;
    if (this.players.length !== 4) return false;
    this.clearCountdown();
    await this.applyCosmeticsToPlayers();
    this.sessionId = crypto.randomUUID();
    this.dealRound(true);
    this.startBotTimer();
    return true;
  }

  /** Fill remaining seats with AI bots then start the game immediately. */
  async fillWithBots() {
    if (this.state !== "waiting") return false;
    const ts = Date.now();
    // Replace empty-slot placeholders (userId=null, not a real bot) with actual bots
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (!p.isBot && !p.userId) {
        this.players[i] = {
          userId: `bot_fill_${ts}_${p.seatIndex}`,
          socketId: null,
          seatIndex: p.seatIndex,
          isBot: true,
          displayName: "بوت",
          chips: 0,
        };
      }
    }
    // Also append bots for any seats not yet in this.players
    const needed = this.maxPlayers - this.players.length;
    for (let i = 0; i < needed; i++) {
      const seatIndex = this.players.length;
      this.players.push({
        userId: `bot_fill_${ts}_${seatIndex}`,
        socketId: null,
        seatIndex,
        isBot: true,
        displayName: "بوت",
        chips: 0,
      });
    }
    const started = await this.startGame();
    if (started) {
      this._notifyAfterMove({ success: true, gameStarted: true });
    }
    return started;
  }

  dealRound(rotateDealer) {
    if (rotateDealer) {
      this.dealerIndex = this.dealerIndex < 0 ? 0 : (this.dealerIndex + 1) % 4;
    } else if (this.dealerIndex < 0) {
      this.dealerIndex = 0;
    }

    const deck = shuffle(newDeck());
    this.hands = [[], [], [], []];

    const startSeat = (this.dealerIndex + 1) % 4;
    for (let i = 0; i < 52; i += 1) {
      this.hands[(startSeat + i) % 4].push(deck[i]);
    }
    const lastSeat = (startSeat + 51) % 4;
    const h = this.hands[lastSeat];
    const lastCard = { ...h[h.length - 1] };
    this.revealedCard = lastCard;
    this.trump = rules.oppositeColorSuit(lastCard.suit);
    this.declaredBids = [null, null, null, null];
    this.tricksThisRound = [0, 0, 0, 0];
    this.trick = [];
    this.lastTrick = [];
    this.ledSuit = null;
    this.state = "bidding_syrian";
    this._fsm.transition(T41_STATE.BIDDING_SYRIAN);
    this.currentPlayerIndex = (this.dealerIndex + 1) % 4;
    this.trickLeader = this.currentPlayerIndex;
    this.startTurnTimer();
  }

  startBotTimer() {
    if (this.botInterval != null) clearManagedOrNativeInterval(this.botInterval);
    this.botInterval = timerManager.schedule(this.roomId, "bot", 1500, () => this.checkBotTurn(), { repeat: true });
  }

  clearBotTimer() {
    if (this.botInterval != null) {
      clearManagedOrNativeInterval(this.botInterval);
      this.botInterval = null;
    }
  }

  startTurnTimer() {
    if (this.trickResolving) {
      this.clearTurnTimer();
      return;
    }
    if (this.state !== "bidding_syrian" && this.state !== "playing") {
      this.clearTurnTimer();
      return;
    }
    const p = this.players[this.currentPlayerIndex];
    if (p && p.isBot) {
      this.clearTurnTimer();
      return;
    }
    this.turnTimerPhase = this.state === "bidding_syrian" ? "bidding" : "playing";
    this.turnTimerEndsAt = Date.now() + this.turnTimerSeconds * 1000;
    this._emitTurnTimerStarted();
    if (this.turnTimerInterval != null) clearManagedOrNativeInterval(this.turnTimerInterval);
    this.turnTimerInterval = timerManager.schedule(this.roomId, "turn", 1000, () => this._tickTurnTimer(), {
      repeat: true,
    });
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
    this.clearCountdown();
    this.clearTrickResolveTimer();
    timerManager.clearAll(this.roomId);
    this._countdownStartGate = null;
    this.onGameEvent = null;
    this.onAfterMove = null;
  }

  clearTrickResolveTimer() {
    if (this.trickResolveTimer != null) {
      if (!timerManager.clear(this.trickResolveTimer)) clearTimeout(this.trickResolveTimer);
      this.trickResolveTimer = null;
    }
    this.trickResolving = false;
    this.pendingTrickWinner = null;
    this.trickResolveEndsAt = null;
  }

  handleTurnTimeout() {
    this._handleTurnTimeout();
  }

  _remainingTurnSeconds() {
    if (!this.turnTimerEndsAt) return 0;
    return Math.max(0, Math.ceil((this.turnTimerEndsAt - Date.now()) / 1000));
  }

  _turnTimerPayload(extra = {}) {
    return {
      phase: this.turnTimerPhase,
      playerIndex: this.currentPlayerIndex,
      remainingSeconds: this._remainingTurnSeconds(),
      ...extra,
    };
  }

  _emitTurnTimerStarted() {
    this._emit("turn_timer_started", this._turnTimerPayload());
  }

  _emitTurnTimerUpdate() {
    this._emit("turn_timer_update", this._turnTimerPayload());
  }

  _tickTurnTimer() {
    if (this.state !== "bidding_syrian" && this.state !== "playing") {
      this.clearTurnTimer();
      return;
    }
    const remaining = this._remainingTurnSeconds();
    this._emitTurnTimerUpdate();
    if (remaining <= 0) {
      this.clearTurnTimer();
      this._handleTurnTimeout();
    }
  }

  _pickAutoPlayCard(hand) {
    return TarneebBot.pickAutoPlayCard(hand, this.ledSuit, rules);
  }

  _handleTurnTimeout() {
    const idx = this.currentPlayerIndex;
    this._emit("turn_timer_expired", this._turnTimerPayload({ auto: true }));
    if (this.state === "bidding_syrian") {
      this.applyMove(idx, "tarneeb41_declare", { value: 0, fromTimeout: true });
    } else if (this.state === "playing") {
      const card = this._pickAutoPlayCard(this.hands[idx]);
      if (!card) return;
      this.applyMove(idx, "play_card", {
        fromTimeout: true,
        card: { suit: rules.toApiSuit(card.suit), rank: rules.toApiRank(card.rank) },
      });
    }
  }

  /** Estimate expected tricks for the current player based on hand strength. */
  _botBid() {
    const idx = this.currentPlayerIndex;
    const hand = this.hands[idx];
    return TarneebBot.botBid(hand, this.trump);
  }

  checkBotTurn() {
    if (
      this.state === "game_end" ||
      this.state === "waiting" ||
      this.state === "countdown" ||
      this.trickResolving
    ) {
      return;
    }

    // Auto-advance from round_end when no humans are connected
    if (this.state === "round_end") {
      const hasConnectedHuman = this.players.some((p) => !p.isBot && p.socketId);
      if (!hasConnectedHuman) {
        this.advanceNextRound();
      }
      return;
    }
    const idx = this.currentPlayerIndex;
    const p = this.players[idx];
    if (!p || !p.isBot) return;

    if (this.state === "bidding_syrian") {
      const v = this._botBid();
      this.applyMove(idx, "tarneeb41_declare", { value: v });
    } else if (this.state === "playing") {
      const card = this._pickAutoPlayCard(this.hands[idx]);
      if (!card) return;
      this.applyMove(idx, "play_card", {
        card: { suit: rules.toApiSuit(card.suit), rank: rules.toApiRank(card.rank) },
      });
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

  allDeclared() {
    return this.declaredBids.every((b) => b !== null);
  }

  findNextUndeclared(from) {
    let c = this.nextSeat(from);
    for (let n = 0; n < 4; n += 1) {
      if (this.declaredBids[c] === null) return c;
      c = this.nextSeat(c);
    }
    return from;
  }

  applyMove(playerIndex, action, payload) {
    const dup = this._checkDuplicateMove(playerIndex, action, payload);
    if (dup) return dup;

    const result = this._executeMove(playerIndex, action, payload);
    this._notifyAfterMove(result);
    return result;
  }

  _executeMove(playerIndex, action, payload) {
    if (action === "tarneeb41_declare") {
      if (this.state !== "bidding_syrian") return { success: false, reason: "not_bidding" };
      if (this.currentPlayerIndex !== playerIndex) return { success: false, reason: "not_your_turn" };
      if (this.declaredBids[playerIndex] !== null) return { success: false, reason: "already_declared" };
      const vr = rules.validateDeclare(payload && payload.value);
      if (!vr.valid) return { success: false, reason: "invalid_declare" };
      this.declaredBids[playerIndex] = vr.v;

      if (!this.allDeclared()) {
        this.currentPlayerIndex = this.findNextUndeclared(this.currentPlayerIndex);
        this.startTurnTimer();
        return { success: true };
      }

      const sum = this.declaredBids.reduce((a, b) => a + b, 0);
      if (sum < rules.SUM_MIN_TO_PLAY) {
        this.dealRound(false);
        return { success: true, redeal: true, reason: "sum_below_min", minSum: rules.SUM_MIN_TO_PLAY };
      }

      this.state = "playing";
      this._fsm.transition(T41_STATE.PLAYING);
      this.trickLeader = (this.dealerIndex + 1) % 4;
      this.currentPlayerIndex = this.trickLeader;
      this.trick = [];
      this.ledSuit = null;
      this.startTurnTimer();
      return { success: true };
    }

    if (action === "play_card") {
      if (this.state !== "playing") return { success: false, reason: "not_playing" };
      if (this.trickResolving) return { success: false, reason: "trick_resolving" };
      if (this.currentPlayerIndex !== playerIndex) return { success: false, reason: "not_your_turn" };
      const { card } = payload || {};
      const vr = rules.validateCardPlay(this.hands[playerIndex], card, this.ledSuit, this.trump);
      if (!vr.valid) return { success: false, reason: vr.reason || "invalid_card" };
      const c = vr.card;
      const hi = this.hands[playerIndex].findIndex((x) => x.suit === c.suit && x.rank === c.rank);
      if (hi < 0) return { success: false, reason: "card_not_in_hand" };
      this.hands[playerIndex].splice(hi, 1);
      this.trick.push({ card: c, playerIndex });
      if (this.trick.length === 1) this.ledSuit = c.suit;

      if (this.trick.length < 4) {
        this.currentPlayerIndex = this.nextSeat(this.currentPlayerIndex);
        this.startTurnTimer();
        return { success: true };
      }

      const winner = rules.winningCardInTrick(this.trick, this.ledSuit, this.trump);
      if (!winner) return { success: false, reason: "trick_error" };

      this.trickResolving = true;
      this.pendingTrickWinner = winner.playerIndex;
      this.clearTurnTimer();
      this.trickResolveEndsAt = Date.now() + TRICK_DISPLAY_MS;
      if (this.trickResolveTimer) timerManager.clear(this.trickResolveTimer);
      this.trickResolveTimer = timerManager.schedule(
        this.roomId,
        "animation_delay",
        TRICK_DISPLAY_MS,
        () => {
          this._finalizePendingTrick();
        },
        { repeat: false }
      );

      return {
        success: true,
        trickComplete: true,
        trickWinner: winner.playerIndex,
        trickDisplayMs: TRICK_DISPLAY_MS,
      };
    }

    if (action === "next_round") {
      if (this.state === "game_end") return { success: false };
      if (this.state !== "round_end") return { success: false, reason: "not_round_end" };
      this.dealRound(true);
      return { success: true };
    }

    return { success: false, reason: "unknown_action" };
  }

  advanceNextRound() {
    return this.applyMove(0, "next_round", {}).success;
  }

  _finalizePendingTrick() {
    if (!this.trickResolving || this.pendingTrickWinner == null) return null;
    const winnerIndex = this.pendingTrickWinner;
    this.lastTrick = this.trick.map((t) => ({
      playerIndex: t.playerIndex,
      card: { rank: t.card.rank, suit: t.card.suit },
    }));
    this.clearTrickResolveTimer();
    this.tricksThisRound[winnerIndex] += 1;
    this.trickLeader = winnerIndex;
    this.currentPlayerIndex = winnerIndex;
    this.trick = [];
    this.ledSuit = null;

    let roundEnded = false;
    if (this.hands[0].length === 0) {
      this.endRound();
      roundEnded = true;
    } else {
      this.startTurnTimer();
    }

    const result = {
      success: true,
      trickWinner: winnerIndex,
      roundEnded,
      trickResolved: true,
    };
    this._notifyAfterMove(result);
    return result;
  }

  /** Test helper — finalize trick without waiting. */
  finalizePendingTrickNow() {
    if (!this.trickResolving) return null;
    if (this.trickResolveTimer) {
      timerManager.clear(this.trickResolveTimer);
      this.trickResolveTimer = null;
    }
    return this._finalizePendingTrick();
  }

  endRound() {
    rules.applyRoundScores(this.declaredBids, this.tricksThisRound, this.playerScores);
    this.roundNumber += 1;
    const end = rules.checkGameEnd(this.playerScores);
    this.clearTurnTimer();
    if (end.ended) {
      this.state = "game_end";
      this._fsm.transition(T41_STATE.GAME_END);
      this.clearBotTimer();
      this._finishedAt = Date.now();
    } else {
      this.state = "round_end";
      this._fsm.transition(T41_STATE.ROUND_END);
    }
  }

  isGameFinished() {
    return this.state === "game_end";
  }

  getRoundResult() {
    return {
      declaredBids: [...this.declaredBids],
      tricksThisRound: [...this.tricksThisRound],
      playerScores: [...this.playerScores],
      trump: this.trump ? rules.toApiSuit(this.trump) : null,
      revealedCard: this._cardToApi(this.revealedCard),
    };
  }

  getGameResult() {
    if (this.state !== "game_end") return null;
    const end = rules.checkGameEnd(this.playerScores);
    return {
      winnerTeam: end.winnerTeam,
      playerScores: [...this.playerScores],
    };
  }

  _cardToApi(c) {
    if (!c) return null;
    return {
      suit: rules.toApiSuit(c.suit),
      rank: rules.toApiRank(c.rank),
    };
  }

  getGameState(forPlayerIndex) {
    const hands = this.hands.map((h, i) =>
      i === forPlayerIndex ? h.map((c) => this._cardToApi(c)) : h.map(() => null)
    );
    const handSizes = this.hands.map((h) => h.length);
    let validCards = [];
    if (this.state === "playing" && forPlayerIndex >= 0 && !this.trickResolving) {
      validCards = rules
        .getValidCards(this.hands[forPlayerIndex], this.ledSuit)
        .map((c) => this._cardToApi(c));
    }

    let trickDisplayRemainingSeconds = 0;
    if (this.trickResolving && this.trickResolveEndsAt) {
      trickDisplayRemainingSeconds = Math.max(
        0,
        Math.ceil((this.trickResolveEndsAt - Date.now()) / 1000)
      );
    }

    const seatsPublic = this.players.map((p, idx) => ({
      seatIndex: idx,
      displayName: p.displayName || (p.isBot ? "بوت" : `لاعب ${idx + 1}`),
      avatar: p.avatar || null,
      userId: !p.isBot ? p.userId || null : null,
      isBot: !!p.isBot,
      chips: p.chips || 0,
      reconnectDeadline:
        !p.isBot && p.reconnectDeadline && p.reconnectDeadline > Date.now()
          ? p.reconnectDeadline
          : null,
      vacatedFromUserId: p.vacatedFromUserId || null,
      vipLevel: p.vipLevel || null,
      cosmetics: publicCosmeticsPayload(p.cosmetics),
    }));

    const gameResult = this.state === "game_end" ? this.getGameResult() : null;

    return {
      state: this.state,
      gameType: this.gameType,
      hands,
      handSizes,
      trick: this.trick.map((t) => ({
        playerIndex: t.playerIndex,
        card: this._cardToApi(t.card),
      })),
      lastTrick: (this.lastTrick || []).map((t) => ({
        playerIndex: t.playerIndex,
        card: this._cardToApi(t.card),
      })),
      ledSuit: this.ledSuit ? rules.toApiSuit(this.ledSuit) : null,
      trump: this.trump ? rules.toApiSuit(this.trump) : null,
      revealedCard: this._cardToApi(this.revealedCard),
      declaredBids: [...this.declaredBids],
      tricksThisRound: [...this.tricksThisRound],
      playerScores: [...this.playerScores],
      dealerIndex: this.dealerIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      trickLeader: this.trickLeader,
      roundNumber: this.roundNumber,
      validCards,
      seatsPublic,
      trickResolving: this.trickResolving,
      trickDisplayRemainingSeconds,
      countdownSeconds: this.state === "countdown" ? this.countdownSeconds : null,
      turnTimer: this.turnTimerPhase
        ? {
            phase: this.turnTimerPhase,
            playerIndex: this.currentPlayerIndex,
            remainingSeconds: this._remainingTurnSeconds(),
          }
        : null,
      ...(gameResult
        ? {
            winnerTeam: gameResult.winnerTeam,
            gameResult,
          }
        : {}),
    };
  }
}

module.exports = Tarneeb41Game;
