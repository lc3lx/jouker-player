const BaseGameEngine = require('../../engine/BaseGameEngine');
const crypto = require('crypto');
const Player = require('./models/Player');
const GameState = require('./models/GameState');
const RoundManager = require('./managers/RoundManager');
const ScoreManager = require('./managers/ScoreManager');
const GameManager = require('./managers/GameManager');
const BotAI = require('./ai/BotAI');
const botPoolService = require('../../services/botPoolService');
const botProfileService = require('../../services/botProfileService');
const botChatService = require('../../services/botChatService');
const timerManager = require('../../engine/TimerManager');
const {
  WAIT_FOR_PLAYERS_MS,
  remainingWaitSeconds,
} = require('../../utils/cardTableTimings');
const { PartnerSelection } = require('../../engine/partnerSelection');
const StateMachine = require('../../engine/StateMachine');
const { STATE: TRIX_STATE, TRANSITIONS: TRIX_TRANSITIONS } = require('../../engine/states/trixStates');
const {
  resolveCardGameCosmeticsForSeats,
  publicCosmeticsPayload,
  emptyCosmetics,
} = require('../../services/playerPublicCosmeticsService');

function clearManagedOrNativeInterval(id) {
  if (!timerManager.clear(id)) clearInterval(id);
}

const ACTIVE_STATES = new Set(['selecting_game', 'playing', 'round_end', 'game_end']);

/** One دق = 4 kingdoms × 5 contracts. Hard stop — never continue past this. */
const TRIX_TOTAL_CONTRACTS = 20;

function countContractsPlayed(gameState) {
  if (!gameState) return 0;
  const byKing = Array.isArray(gameState.gamesPlayedByKing)
    ? gameState.gamesPlayedByKing
    : [];
  const fromKings = byKing.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
  const fromLog = Array.isArray(gameState.scoreLog) ? gameState.scoreLog.length : 0;
  const fromRound = Number(gameState.roundNumber) || 0;
  return Math.max(fromKings, fromLog, fromRound);
}

function isTrixDealComplete(gameState) {
  if (!gameState) return false;
  const byKing = Array.isArray(gameState.gamesPlayedByKing)
    ? gameState.gamesPlayedByKing
    : [];
  const allKingsDone =
    byKing.length >= 4 && byKing.every((row) => Array.isArray(row) && row.length >= 5);
  return allKingsDone || countContractsPlayed(gameState) >= TRIX_TOTAL_CONTRACTS;
}

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

/**
 * Partnership trix (تركس شركة) differs from the individual game (اليهودية) in
 * exactly one place: facing players are partners and their scores are summed.
 * The five contracts, their penalties, the kingdom rotation and the Trix ladder
 * are identical — so both modes share this engine, and only the unit that wins
 * at the end changes.
 */
const TRIX_MODES = new Set(['solo', 'partnership']);

function normalizeTrixMode(mode) {
  const m = String(mode || '').toLowerCase();
  return TRIX_MODES.has(m) ? m : 'solo';
}

/** Seats 0+2 form team 0, seats 1+3 team 1. */
function teamOfSeat(seatIndex) {
  return seatIndex % 2;
}

/** The chair a Mongo seat row occupies; array order for rows predating choice. */
function chairOfSeat(seat, index) {
  const n = Number(seat?.seatPosition);
  return Number.isInteger(n) && n >= 0 ? n : index;
}

/** Chairs of a four-seat table that nobody in `players` has claimed. */
function freeChairsAround(players) {
  const taken = new Set(
    (players || []).map((p, i) => (Number.isInteger(p?.chair) ? p.chair : i))
  );
  const out = [];
  for (let i = 0; i < 4; i += 1) if (!taken.has(i)) out.push(i);
  return out;
}

/**
 * Order the roster by the chairs people picked and renumber seatIndex to match.
 *
 * The engine indexes hands, scores and turn order by `seatIndex`, so this is
 * only ever safe before a deal -- the same rule partner selection follows.
 */
function reindexByChair(players) {
  if (!Array.isArray(players)) return players;
  players.sort((a, b) => {
    const ac = Number.isInteger(a?.chair) ? a.chair : 0;
    const bc = Number.isInteger(b?.chair) ? b.chair : 0;
    return ac - bc;
  });
  players.forEach((p, i) => {
    if (p) p.seatIndex = i;
  });
  return players;
}

class TrixGame extends BaseGameEngine {
  constructor(roomId, options = {}) {
    super(roomId, 'trix', options);
    this.maxPlayers = 4;
    /**
     * Identity of this *table session* — the stretch of time one group of
     * people occupies the table.
     *
     * Minted here, in the constructor, and **not** per deal: the instance is
     * created when someone sits at an empty table and destroyed when the last
     * human leaves (`clearTrixGame` / `clearTarneeb41Game`), so this changes
     * exactly when the table turns over. `sessionId` is per دق and is a
     * different thing — settlement identity.
     *
     * The table chat is never stored anywhere; it lives in each client's list
     * and was never cleared, so a player who stayed kept every message from
     * everyone who had since left. Clients drop their chat when this changes.
     */
    this.tableSessionId = crypto.randomUUID();

    /** @type {'solo'|'partnership'} */
    this.gameMode = normalizeTrixMode(options.gameMode);
    /**
     * Bots may fill this table at all. Tournament tables set it false; a normal
     * cash table leaves it true. Only ever changed from a table document that
     * actually carries `settings` — a synthetic stand-in must not silently
     * re-enable bots on a table that is deliberately humans-only.
     */
    this.botsEnabled = true;
    /**
     * The open seat is held for real players until this moment, and only then
     * do bots come down and the deal start. Null once the deal has begun.
     * @type {number|null} ms epoch
     */
    this.waitForPlayersUntil = null;
    this.waitForPlayersTimer = null;
    /**
     * False until the wait has run out. While false `syncLobbyFromTable` seats
     * humans only — otherwise the roster would show three bots the instant the
     * first player walked in, which is the thing the wait exists to prevent.
     */
    this.botFillReleased = false;
    /**
     * تركس شركة only: the pairs are chosen before the deal, and choosing them
     * is what sets the seating (facing seats are partners everywhere in this
     * engine). Null in the individual game, which has no partners.
     * @type {import('../../engine/partnerSelection').PartnerSelection|null}
     */
    this.partnerSelection = null;
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
    /** @type {Promise<boolean>|null} single-flight guard for concurrent startGame */
    this._startPromise = null;
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

  _emitPassedPlayers() {
    if (
      Array.isArray(this.gameState?.lastPassedPlayers) &&
      this.gameState.lastPassedPlayers.length > 0
    ) {
      for (const seat of this.gameState.lastPassedPlayers) {
        this._emit('player_pass', { tableId: this.roomId, playerIndex: seat });
      }
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
    this.clearWaitForPlayers();
    this.partnerSelection?.destroy();
    timerManager.clearAll(this.roomId);
    // Free any persistent bot identities this game was holding.
    try {
      for (const p of this.players || []) {
        if (p && p.isBot) botPoolService.release(p.botUserId || p.userId);
      }
    } catch (_) { /* best-effort */ }
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
      stateRevision: this.stateRevision,
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
          this._emitPassedPlayers();
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

  /**
   * Overlay a persistent bot identity (name/avatar/personality) onto a bot
   * player object. IDENTITY ONLY — `isBot:true` is preserved so the settlement
   * money path still nulls the wallet. Falls back to the synthetic name when the
   * pool is empty. `keepSeatKey` retains a vacate placeholder id for restore.
   */
  _applyBotIdentity(p, { fallbackName = 'بوت', keepSeatKey = null } = {}) {
    try {
      const existing = this.players
        .filter((x) => x && x.isBot && x.userId)
        .map((x) => String(x.userId));
      const id = botPoolService.acquire(existing);
      if (id) {
        p.userId = keepSeatKey || id.userId;
        p.botUserId = id.userId;
        p.displayName = id.name || fallbackName;
        p.avatar = id.avatar || p.avatar || null;
        p.botPersonality = id.personality;
        p.botSkill = id.skill;
        p.botTuning = id.tuning;
        p.botLang = id.language;
        return;
      }
    } catch (_) { /* pool unavailable */ }
    if (!p.displayName) p.displayName = fallbackName;
  }

  /**
   * Keep the parallel gameState `Player` in sync with a lobby-row bot/human flip.
   * getGameState reads `gp.isBot`/`gp.name` and the 900ms bot loop gates on
   * `gameState.players[idx].isBot` — without this the vacated seat renders as the
   * human AND the bot loop won't drive it (it limps on the 30s human timeout).
   */
  _syncGameStateSeat(seatIndex, isBot, name) {
    const gp =
      this.gameState && this.gameState.players
        ? this.gameState.players[seatIndex]
        : null;
    if (!gp) return;
    gp.isBot = isBot;
    if (name != null) gp.name = name;
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
    this._applyBotIdentity(p, { keepSeatKey: p.userId });
    this._syncGameStateSeat(p.seatIndex, true, p.displayName);
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
    this._syncGameStateSeat(seatIndex, false, p.displayName);

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

  /**
   * Bot seats a new human may take over (the engine is the source of truth for
   * seat positions). Mirrors tarneeb41BotSeatService.listReplaceableBotSeats.
   */
  listReplaceableBotSeats() {
    if (!Array.isArray(this.players)) return [];
    return this.players
      .filter((p) => p && p.isBot && typeof p.seatIndex === "number")
      .map((p) => ({
        seatIndex: p.seatIndex,
        vacatedFromUserId: p.vacatedFromUserId ? String(p.vacatedFromUserId) : null,
      }));
  }

  /**
   * Adopt the table's bot policy. Guarded the way poker's is: a document with
   * no `settings` is a synthetic stand-in, and reading `undefined !== false` off
   * one is how a deliberately humans-only table quietly gets bots again.
   */
  applyTablePolicy(tableDoc) {
    if (!tableDoc || typeof tableDoc.settings !== 'object' || tableDoc.settings === null) {
      return;
    }
    this.botsEnabled = tableDoc.settings.botsEnabled !== false;
  }

  async syncLobbyFromTable(tableDoc, resolveSocket) {
    this.applyTablePolicy(tableDoc);
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

    // Seated in the chair each player picked. `seatPosition` is what the join
    // recorded; rows from before players could choose carry none, and for those
    // the array order was the chair, so that is the fallback.
    this.players = [];
    const bySeat = tableDoc.seats
      .map((seat, i) => ({ seat, chair: chairOfSeat(seat, i) }))
      .sort((a, b) => a.chair - b.chair);

    for (const { seat, chair } of bySeat) {
      const uid = seat.user && seat.user._id ? seat.user._id : seat.user;
      const uidStr = String(uid);
      let nm = `لاعب ${chair + 1}`;
      let avatar = null;
      if (seat.user && typeof seat.user === 'object') {
        if (seat.user.name) nm = String(seat.user.name);
        avatar = seat.user.profileImg || null;
      }
      this.players.push({
        userId: uid,
        socketId: resolveSocket(uidStr) || null,
        seatIndex: this.players.length,
        chair,
        isBot: false,
        displayName: nm,
        avatar,
        chips: Number(seat.chips) || 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
      });
    }
    // Humans only until the wait for real players has run out. Filling here is
    // what used to put three bots on the table the moment someone sat down.
    let bi = 0;
    const freeChairs = freeChairsAround(this.players);
    while (this.botFillReleased && this.botsEnabled && this.players.length < 4) {
      const botId = `bot_${Date.now()}_${bi}_${Math.random().toString(36).substr(2, 9)}`;
      bi += 1;
      const bot = {
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        // Bots take the chairs nobody picked, so once the table is full every
        // human is sitting exactly where they chose.
        chair: freeChairs.shift() ?? this.players.length,
        isBot: true,
        displayName: 'بوت',
        avatar: null,
        chips: 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
      };
      this._applyBotIdentity(bot);
      this.players.push(bot);
    }
    reindexByChair(this.players);
    await this.applyCosmeticsToPlayers();
  }

  /**
   * Resolve store skin + VIP table/card overrides for all human players and
   * cache the result on each lobby row. Call after roster changes (join,
   * bot-replace, syncLobbyFromTable) before building outgoing state.
   */
  async applyCosmeticsToPlayers() {
    const seatsForResolve = this.players.map((p, index) => ({
      userId: p.userId,
      isBot: !!p.isBot,
      seatIndex: Number.isFinite(p.seatIndex) ? p.seatIndex : index,
    }));
    // Also resolves the table-wide felt now. This game used to get profile
    // skins only, so a table theme a player owned could not reach it.
    const { byUserId: map, activeTableTheme } =
      await resolveCardGameCosmeticsForSeats(seatsForResolve);
    this.activeTableTheme = activeTableTheme || null;
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

  /**
   * Idempotent + single-flight: concurrent join handlers share one start, and
   * callers that already have gameState get an immediate success.
   */
  /** Seconds left before bots come down; 0 when no wait is running. */
  remainingWaitSeconds() {
    return remainingWaitSeconds(this.waitForPlayersUntil);
  }

  /** True while the table is holding its seats open for real players. */
  isWaitingForPlayers() {
    return !this.gameState && this.waitForPlayersUntil != null;
  }

  clearWaitForPlayers() {
    if (this.waitForPlayersTimer != null) {
      if (!timerManager.clear(this.waitForPlayersTimer)) {
        clearTimeout(this.waitForPlayersTimer);
      }
      this.waitForPlayersTimer = null;
    }
    this.waitForPlayersUntil = null;
  }

  /**
   * The entry the join path calls instead of `startGame()`.
   *
   * A full table of humans deals at once. Anything less holds the empty seats
   * open for WAIT_FOR_PLAYERS_MS; only when that runs out do bots sit down and
   * the deal begin.
   *
   * @returns {Promise<{ started: boolean, waiting: boolean, remainingSeconds: number }>}
   */
  async startOrWaitForPlayers() {
    if (this.gameState) {
      return { started: true, waiting: false, remainingSeconds: 0 };
    }

    if (this.humanCount() >= 4) {
      this.clearWaitForPlayers();
      this.botFillReleased = true;
      await this._dealOrChoosePartners();
      return {
        started: !!this.gameState,
        waiting: false,
        choosingPartners: this.isChoosingPartners(),
        remainingSeconds: 0,
      };
    }

    if (this.humanCount() <= 0) {
      // Nobody is here — nothing to hold a seat for.
      this.clearWaitForPlayers();
      return { started: false, waiting: false, remainingSeconds: 0 };
    }

    this.armWaitForPlayers();
    return {
      started: false,
      waiting: true,
      remainingSeconds: this.remainingWaitSeconds(),
    };
  }

  /** Start the window, or leave a running one alone. */
  armWaitForPlayers() {
    if (this.gameState) return false;
    if (this.waitForPlayersTimer != null) return false;

    this.waitForPlayersUntil = Date.now() + WAIT_FOR_PLAYERS_MS;
    this.waitForPlayersTimer = timerManager.schedule(
      this.roomId,
      'wait_for_players',
      WAIT_FOR_PLAYERS_MS,
      () => {
        this.waitForPlayersTimer = null;
        void this._onWaitForPlayersElapsed();
      }
    );
    this._emit('waiting_for_players', {
      tableId: this.roomId,
      remainingSeconds: this.remainingWaitSeconds(),
      humanCount: this.humanCount(),
    });
    return true;
  }

  async _onWaitForPlayersElapsed() {
    this.clearWaitForPlayers();
    if (this.gameState) return;

    // Still nobody at all: let the table go back to sleep rather than dealing
    // to an empty room.
    if (this.humanCount() <= 0) return;

    if (!this.botsEnabled) {
      // A humans-only table keeps waiting instead of leaving a finished
      // countdown with no timer behind it (the poker lesson).
      this.armWaitForPlayers();
      this.notifyStateChanged();
      return;
    }

    this.botFillReleased = true;
    this._fillSeatsWithBots();
    await this.applyCosmeticsToPlayers();
    await this._dealOrChoosePartners();
    this.notifyStateChanged();
  }

  /** True while the table is picking its pairs (تركس شركة, before the deal). */
  isChoosingPartners() {
    return !!this.partnerSelection && this.partnerSelection.active;
  }

  partnerSelectionPayload() {
    return this.partnerSelection ? this.partnerSelection.toPayload() : null;
  }

  /**
   * The last gate before cards are dealt.
   *
   * On a شركة table the four players first settle who is partnered with whom,
   * because in this engine that decision *is* the seating order. Everywhere
   * else this is just "deal".
   */
  async _dealOrChoosePartners() {
    if (this.gameState) return;
    if (!this.isPartnership) {
      await this.startGame();
      return;
    }
    if (this.partnerSelection && this.partnerSelection.isSettled) {
      await this.startGame();
      return;
    }
    if (this.isChoosingPartners()) return; // already in the exchange

    this.partnerSelection = new PartnerSelection({
      roomId: this.roomId,
      getPlayers: () => this.players,
      onSeatsArranged: (arranged) => {
        // Safe only because no cards exist yet: after the deal, seat indices
        // own the hands, the scores and the trick order.
        this.players = arranged;
      },
      onSettled: () => {
        void this._afterPartnersSettled();
      },
      onUpdate: (payload) => {
        this._emit('partner_selection', { tableId: this.roomId, ...payload });
      },
    });
    this.partnerSelection.begin();
  }

  async _afterPartnersSettled() {
    await this.applyCosmeticsToPlayers();
    await this.startGame();
    this.notifyStateChanged();
  }

  /** The chooser names a partner. */
  choosePartner(seatIndex, byUserId) {
    if (!this.partnerSelection) return { ok: false, reason: 'not_choosing' };
    return this.partnerSelection.choose(seatIndex, byUserId);
  }

  /** The named player accepts or declines. */
  respondToPartner(accepted, byUserId) {
    if (!this.partnerSelection) return { ok: false, reason: 'not_awaiting' };
    return this.partnerSelection.respond(accepted, byUserId);
  }

  /** Seat a bot on every empty chair. Only ever called past the wait window. */
  _fillSeatsWithBots() {
    const freeChairs = freeChairsAround(this.players);
    while (this.players.length < 4) {
      const botId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const bot = {
        userId: botId,
        socketId: null,
        seatIndex: this.players.length,
        chair: freeChairs.shift() ?? this.players.length,
        isBot: true,
        displayName: 'بوت',
        chips: 0,
        vipLevel: null,
        cosmetics: emptyCosmetics(),
      };
      this._applyBotIdentity(bot);
      this.players.push(bot);
    }
    reindexByChair(this.players);
  }

  async startGame() {
    if (this.gameState) return true;
    if (this._startPromise) return this._startPromise;
    this._startPromise = this._startGameInternal().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }

  async _startGameInternal() {
    if (this.gameState) return true;

    this.sessionId = crypto.randomUUID();
    this._settlementTriggered = false;
    this._lastSettlementPayload = null;
    this._finishedAt = null;
    this._settlementCompleted = false;
    this.processedMoveIds = new Set();

    // Dealing needs four seats. Reaching this with fewer means the wait for
    // real players has already been resolved one way or the other, so filling
    // here is the last step of that decision rather than a shortcut past it.
    this.clearWaitForPlayers();
    this.botFillReleased = true;
    this._fillSeatsWithBots();

    await this.applyCosmeticsToPlayers();

    if (typeof this._beforeDealStart === "function") {
      await this._beforeDealStart();
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
    // Safety: never deal another hand once the دق is complete.
    if (isTrixDealComplete(this.gameState)) {
      this._finishDeal('startRound_blocked');
      return;
    }
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

  /**
   * End the دق: celebration + settlement. Idempotent.
   */
  _finishDeal(reason = 'complete') {
    if (this.state === 'game_end') return true;
    this.state = 'game_end';
    this._fsm.transition(TRIX_STATE.GAME_END);
    this.clearBotTimer();
    this.clearTurnTimer();
    if (!this._finishedAt) this._finishedAt = Date.now();
    // #region agent log
    try {
      const { agentDebugLog } = require('../../utils/agentDebugLog');
      agentDebugLog('H-20', 'TrixGame.js:_finishDeal', 'trix deal finished', {
        reason,
        tableId: String(this.mongoTableId || this.roomId || ''),
        roundNumber: Number(this.gameState?.roundNumber) || 0,
        contractsPlayed: countContractsPlayed(this.gameState),
        scoreLogLen: Array.isArray(this.gameState?.scoreLog)
          ? this.gameState.scoreLog.length
          : 0,
        byKing: (this.gameState?.gamesPlayedByKing || []).map((r) =>
          Array.isArray(r) ? r.length : 0
        ),
        scores: this.gameState?.scores || [],
        state: this.state,
      });
    } catch (_) {}
    // #endregion
    try {
      const scores = this.gameState?.scores || [];
      const maxScore = Math.max(...scores);
      botProfileService.recordSeats(
        this.players.map((p) => ({
          isBot: !!p.isBot,
          botUserId: p.botUserId,
          userId: p.userId,
          won: scores[p.seatIndex] === maxScore,
        })),
        { gameType: 'trix' }
      );
    } catch (_) { /* cosmetic only */ }
    try {
      const bots = this.players.filter((p) => p.isBot).map((p) => botChatService.botFromSeat(p));
      const res = botChatService.maybeChat({ bots, tableId: this.roomId, event: 'hand_end' });
      if (res) setTimeout(() => this._emit('bot_chat', res.message), res.delayMs);
    } catch (_) { /* best-effort */ }
    this._notifyAfterMove({ success: true, gameEnded: true });
    return true;
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
      // No contracts left for anyone → force end (never wrap into a 2nd دق).
      if (isTrixDealComplete(this.gameState)) {
        this._finishDeal('bot_select_deal_complete');
        stateChanged = true;
      } else {
        const kingIndex = this.gameState.currentKingIndex;
        const king = this.gameState.players[kingIndex];
        const available = RoundManager.getAvailableGames(this.gameState, kingIndex);
        if (available.length === 0) {
          // Current king finished their 5 — advance or end.
          this.state = 'round_end';
          this._fsm.transition(TRIX_STATE.ROUND_END);
          this.roundEndAt = Date.now() - 2000;
          const ok = this.nextRound();
          if (ok) stateChanged = true;
        } else {
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
      }
    } else if (this.state === 'playing') {
      if (this.gameState.currentGameType === 'Trix') {
        const turnIndex = this.gameState.turnPlayerIndex;
        const valid = GameManager.getValidCards(this.gameState, turnIndex);
        if (valid.length === 0) {
          const before = this.gameState.turnPlayerIndex;
          GameManager.nextTurn(this.gameState);
          this._emitPassedPlayers();
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
          // Personality/skill opts from the lobby seat (null → default behavior).
          const lp = this.players.find((p) => p.seatIndex === turnIndex) || this.players[turnIndex];
          const botOpts = lp && lp.isBot && lp.botTuning
            ? { personality: lp.botPersonality, skill: lp.botSkill, tuning: lp.botTuning }
            : null;
          // On a شركة table the facing seat is a partner, so a trick it is
          // already winning is not worth overtaking.
          const botCtx = this.isPartnership
            ? { partnerIndex: (turnIndex + 2) % 4 }
            : null;
          const card = BotAI.botChooseCard(
            this.gameState,
            turnIndex,
            valid,
            botOpts,
            botCtx,
          );
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
          this._emitPassedPlayers();
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
      // The table session this state belongs to — clients drop their chat
      // when it changes. See the constructor.
      tableSessionId: this.tableSessionId,
      // Which seat this snapshot was masked for. The client renders the table
      // from its own seat outwards, and a seat index can change under it —
      // تركس شركة re-seats everyone when the pairs settle — so every snapshot
      // has to say which chair the receiver is sitting in *now*.
      viewPlayerIndex: forPlayerIndex,
      // The felt everyone at this table sees — resolved in
      // applyCosmeticsToPlayers from seated VIP first, then the lowest-seated
      // player's equipped theme. Same key space as poker.
      activeTableTheme: this.activeTableTheme || null,
      // "solo" (يهودية) or "partnership" (شركة) — the client pairs facing
      // seats and shows one combined total per team when partnership.
      gameMode: this.gameMode,
      teamScores: this.isPartnership ? this.teamScores() : null,
      // Additive lifecycle envelope (clients drop stale packets by revision).
      stateRevision: this.stateRevision,
      roundId: this.gameState.roundNumber,
      sessionPhase: this.getLifecyclePhase(),
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
      scoreLog: Array.isArray(this.gameState.scoreLog)
        ? this.gameState.scoreLog.map((row) => ({
            gameType: row.gameType,
            kingIndex: row.kingIndex,
            roundNumber: row.roundNumber,
            deltas: Array.isArray(row.deltas) ? [...row.deltas] : [0, 0, 0, 0],
            totals: Array.isArray(row.totals) ? [...row.totals] : [0, 0, 0, 0],
          }))
        : [],
      turnPlayerIndex: this.gameState.turnPlayerIndex,
      currentKingIndex: this.gameState.currentKingIndex,
      currentGameType: this.gameState.currentGameType,
      roundNumber: this.gameState.roundNumber,
      gamesPlayedByKing: this.gameState.gamesPlayedByKing.map((row) => [...row]),
      trixTable: JSON.parse(JSON.stringify(this.gameState.trixTable)),
      finishedPlayers: [...this.gameState.finishedPlayers],
      lastPassedPlayers: Array.isArray(this.gameState.lastPassedPlayers)
        ? [...this.gameState.lastPassedPlayers]
        : [],
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
      // During round_end use the committed snapshot so we never double-count.
      roundScores:
        this.state === 'round_end'
          ? Array.isArray(this.gameState.lastRoundDelta)
            ? [...this.gameState.lastRoundDelta]
            : [0, 0, 0, 0]
          : this.gameState.currentGameType && this.state === 'playing'
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
    if (this.state === 'game_end') {
      return { success: false, reason: 'Game already finished' };
    }
    const dup = this._checkDuplicateMove(playerIndex, action, payload);
    if (dup) {
      this._notifyAfterMove(dup);
      return dup;
    }

    if (this.state === 'selecting_game' && action === 'select_game') {
      if (isTrixDealComplete(this.gameState)) {
        this._finishDeal('select_blocked');
        return { success: false, reason: 'Deal already complete' };
      }
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
          this._emitPassedPlayers();
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
        this._emitPassedPlayers();
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
    if (this.state === 'game_end') return false;
    if (this.state !== 'round_end') return false;
    this.roundEndAt = 0;

    const contractsPlayed = countContractsPlayed(this.gameState);
    // #region agent log
    try {
      const { agentDebugLog } = require('../../utils/agentDebugLog');
      agentDebugLog('H-20', 'TrixGame.js:nextRound', 'nextRound decision', {
        tableId: String(this.mongoTableId || this.roomId || ''),
        roundNumber: Number(this.gameState?.roundNumber) || 0,
        contractsPlayed,
        dealComplete: isTrixDealComplete(this.gameState),
        byKing: (this.gameState?.gamesPlayedByKing || []).map((r) =>
          Array.isArray(r) ? r.length : 0
        ),
      });
    } catch (_) {}
    // #endregion

    if (isTrixDealComplete(this.gameState)) {
      return this._finishDeal('nextRound_complete');
    }

    const kingIndex = this.gameState.currentKingIndex;
    if (this.gameState.gamesPlayedByKing[kingIndex].length >= 5) {
      this.gameState.currentKingIndex = (kingIndex + 1) % 4;
    }

    // After rotating, if every king is done, end — do not startRound again.
    if (isTrixDealComplete(this.gameState)) {
      return this._finishDeal('nextRound_after_rotate');
    }

    this.gameState.players.forEach((p) => p.resetForRound());
    this.startRound();
    this._notifyAfterMove({ success: true, roundAdvanced: true });
    return true;
  }

  getRoundResult() {
    return {
      gameMode: this.gameMode,
      scores: [...this.gameState.scores],
      teamScores: this.isPartnership ? this.teamScores() : null,
      finishedPlayers: [...this.gameState.finishedPlayers],
    };
  }

  /** Summed scores per team; index 0 is seats 0+2, index 1 is seats 1+3. */
  teamScores() {
    const scores = this.gameState?.scores || [];
    const totals = [0, 0];
    for (let i = 0; i < 4; i += 1) {
      const n = Number(scores[i]);
      totals[teamOfSeat(i)] += Number.isFinite(n) ? n : 0;
    }
    return totals;
  }

  get isPartnership() {
    return this.gameMode === 'partnership';
  }

  getGameResult() {
    const scores = [...this.gameState.scores];

    let winnerIndex = 0;
    let maxScore = -Infinity;
    scores.forEach((s, i) => {
      if (s > maxScore) {
        maxScore = s;
        winnerIndex = i;
      }
    });

    if (!this.isPartnership) {
      return { gameMode: 'solo', winnerIndex, scores };
    }

    // Partnership: the pair with the higher combined score takes the deal. A
    // dead tie leaves winnerTeam null, which settlement reads as "no winner"
    // and refunds every seat rather than guessing.
    const totals = this.teamScores();
    const winnerTeam =
      totals[0] === totals[1] ? null : totals[0] > totals[1] ? 0 : 1;

    return {
      gameMode: 'partnership',
      winnerTeam,
      teamScores: totals,
      // Kept so anything reading the solo shape still gets a sane seat.
      winnerIndex,
      scores,
    };
  }
}

module.exports = TrixGame;
module.exports.normalizeTrixMode = normalizeTrixMode;
module.exports.teamOfSeat = teamOfSeat;
