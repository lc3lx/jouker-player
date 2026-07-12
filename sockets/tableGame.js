const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const Table = require("../models/tableModel");
const HandHistory = require("../models/handHistoryModel");
const { newDeck, shuffleDeterministic, draw, sha256Hex, randomInt: secureRandomInt } = require("../utils/poker/deck");
const { bestOf7, compareHands7 } = require("../utils/poker/handEval");
const Jackpot = require("../models/jackpotModel");
const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const { RedisTableStateStore } = require("../utils/tableStateStore");
const { applyLockedDelta, applyHouseSettlementDelta, withMongoTransaction } = require("../services/walletLedgerService");
const logger = require("../utils/logger");
const tableChat = require("./tableChat");
const { metrics } = require("../utils/metrics");
const { sendAlert } = require("../utils/alert");
const { trackEventServerFireAndForget } = require("../services/analyticsService");
const { evaluateHandChipDumpSuspect } = require("../services/fraudService");
const cosmeticsService = require("../services/cosmeticsService");
const { attachRedisClient: attachCosmeticsEquippedCache } = require("../utils/cosmeticsEquippedCache");
const vipService = require("../services/vipService");
const { attachRedisClient: attachVipLevelCache } = require("../utils/vipLevelCache");
const {
  buildPokerLobbyFields,
  derivePokerTableStatus,
  normalizeCapacity,
  countHumanSeatsFromEngine,
  POKER_CAPACITY,
  POKER_MIN_PLAYERS,
} = require("../utils/pokerTableStatus");
const { POKER_TIMINGS, sleep } = require("../utils/poker/timings");
const {
  sortSeatsByPosition,
  nextFreeSeatPosition,
  POKER_OPPOSITE_DEALER_SEAT,
} = require("../services/pokerTableAllocationService");
const {
  PLAYER_STATE,
  defaultPlayerState,
  canParticipateInNextHand,
  canBeDealtIntoHand,
  promoteWaitingToSeated,
  markActiveHandParticipants,
  countEligibleHumans,
  createSeatDefaults,
  isHumanSeat,
} = require("../utils/poker/playerState");
const { verifyHandChipConservation } = require("../utils/poker/chipConservation");
const { auditOrFreeze, auditChipConservation } = require("../utils/poker/chipAuditor");
const { deriveMinimumBet } = require("../utils/poker/tableBettingConfig");
const { buildHandAuditLog } = require("../services/handHistoryAuditService");

function getTokenFromHandshake(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token.replace(/^Bearer\s+/i, "");
  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.split(" ")[1];
  const query = socket.handshake.query || {};
  if (query.token) return String(query.token).replace(/^Bearer\s+/i, "");
  return null;
}

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, toSafeInt(value, min)));
}

function isBotUserId(userId) {
  return typeof userId === "string" && userId.startsWith("bot:");
}

/**
 * Hole cards visible to a socket — server is the source of truth (handEval / showdown only on backend).
 * - Spectators & opponents: hidden until showdown reveal step includes their seat (showdownRevealedSeats).
 * - Hero: always receives own hole cards when dealt (so play is possible); never ranked on the client.
 * - Idle: last-hand showdown holes replayed from lastHand.seats when present.
 */
function mapHoleForClientView({ round, lastHand, seat, seatIndex, forUserId, showdownRevealedSeats }) {
  const hole = Array.isArray(seat.hole) ? seat.hole : [];
  const pair = () => {
    if (hole.length >= 2) return [hole[0], hole[1]];
    return [hole[0] ?? null, hole[1] ?? null];
  };

  const r = String(round || "");
  const srs = showdownRevealedSeats instanceof Set ? showdownRevealedSeats : null;

  // Local player always sees their own board (incl. during staged showdown before their reveal step).
  if (forUserId != null && String(forUserId) === String(seat.userId)) {
    return pair();
  }

  if (r === "showdown" && srs) {
    if (!srs.has(seatIndex)) return [null, null];
    return pair();
  }

  // Strict: never reveal opponent holes during showdown without an explicit reveal Set
  // (avoids leaks if showdownRevealedSeats is missing from a bad snapshot).
  if (r === "showdown") {
    return [null, null];
  }
  if (r === "idle" && lastHand && lastHand.reason === "showdown" && Array.isArray(lastHand.seats)) {
    const row = lastHand.seats.find(
      (x) => toSafeInt(x.seatIndex, -1) === seatIndex || String(x.userId) === String(seat.userId)
    );
    if (row && Array.isArray(row.hole) && row.hole.some((c) => c != null && String(c).length > 0)) {
      return [row.hole[0] ?? null, row.hole[1] ?? null];
    }
  }
  return [null, null];
}

function emptyClientActionSpec() {
  return {
    allowedActions: [],
    callAmount: 0,
    minRaise: 0,
    maxRaise: 0,
    canCheck: false,
    isAllInOnly: false,
  };
}

/** Normalize engine spec (allowed) to strict client contract (allowedActions). */
function normalizeClientActionSpec(raw, isActor) {
  if (!isActor || !raw) return emptyClientActionSpec();
  const allowedRaw = raw.allowedActions || raw.allowed;
  const list = Array.isArray(allowedRaw)
    ? allowedRaw.map((x) => String(x).toLowerCase())
    : [];
  return {
    allowedActions: list,
    callAmount: toSafeInt(raw.callAmount, 0),
    minRaise: toSafeInt(raw.minRaise, 0),
    maxRaise: toSafeInt(raw.maxRaise, 0),
    canCheck: raw.canCheck === true,
    isAllInOnly: raw.isAllInOnly === true,
  };
}

function handCategoryName(rank) {
  if (!rank || !Number.isFinite(rank.cat)) return null;
  if (rank.cat === 8 && Array.isArray(rank.tiebreak) && rank.tiebreak[0] === 14) {
    return "Royal Flush";
  }
  const names = [
    "High Card",
    "One Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
  ];
  return names[rank.cat] || null;
}

class InMemoryTableLockManager {
  constructor() {
    this.locks = new Set();
  }

  async acquire(tableId) {
    if (!tableId) return false;
    if (this.locks.has(tableId)) return false;
    this.locks.add(tableId);
    return true;
  }

  async release(tableId) {
    if (!tableId) return;
    this.locks.delete(tableId);
  }
}

class RedisTableLockManager {
  constructor(redis) {
    this.redis = redis;
    this.tokens = new Map();
    this.instanceId = process.env.INSTANCE_ID || `pid:${process.pid}`;
    this.ttlMs = toSafeInt(process.env.POKER_ACTION_LOCK_TTL_MS, 8000);
  }

  lockKey(tableId) {
    return `poker:lock:table:${tableId}`;
  }

  async acquire(tableId) {
    if (!tableId || !this.redis) return false;
    const token = `${this.instanceId}:${Date.now()}:${crypto.randomBytes(12).toString("hex")}`;
    const ok = await this.redis.set(this.lockKey(tableId), token, {
      NX: true,
      PX: this.ttlMs,
    });
    if (ok !== "OK") return false;
    this.tokens.set(tableId, token);
    return true;
  }

  async release(tableId) {
    if (!tableId || !this.redis) return;
    const token = this.tokens.get(tableId);
    if (!token) return;
    const lua = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await this.redis.eval(lua, {
        keys: [this.lockKey(tableId)],
        arguments: [token],
      });
    } finally {
      this.tokens.delete(tableId);
    }
  }
}

class SocketSecurityGuard {
  constructor() {
    this.actionWindowMs = Math.max(1000, toSafeInt(process.env.POKER_ACTION_WINDOW_MS, 1000));
    this.actionPerWindow = Math.max(2, toSafeInt(process.env.POKER_ACTION_RATE_LIMIT, 6));
    this.connectWindowMs = Math.max(1000, toSafeInt(process.env.POKER_CONNECT_WINDOW_MS, 10000));
    this.connectPerWindow = Math.max(2, toSafeInt(process.env.POKER_CONNECT_RATE_LIMIT, 12));
    this.banBaseMs = Math.max(5000, toSafeInt(process.env.POKER_BAN_BASE_MS, 30000));
    this.banMaxMs = Math.max(this.banBaseMs, toSafeInt(process.env.POKER_BAN_MAX_MS, 10 * 60 * 1000));
    this.buckets = new Map();
    this.violations = new Map();
    this.bans = new Map();
    this.socketSeen = new Set();
  }

  getIp(socket) {
    return (
      socket?.handshake?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
      socket?.handshake?.address ||
      "unknown"
    );
  }

  _bucketKey(type, key) {
    return `${type}:${key || "na"}`;
  }

  _take(type, key, limit, windowMs) {
    const now = Date.now();
    const k = this._bucketKey(type, key);
    const row = this.buckets.get(k);
    if (!row || row.resetAt <= now) {
      this.buckets.set(k, { count: 1, resetAt: now + windowMs });
      return true;
    }
    row.count += 1;
    return row.count <= limit;
  }

  _banKey(userId, ip) {
    return `${userId || "na"}|${ip || "na"}`;
  }

  _isBanned(userId, ip) {
    const key = this._banKey(userId, ip);
    const until = this.bans.get(key) || 0;
    return until > Date.now();
  }

  _registerViolation(kind, userId, ip, details = {}) {
    const key = this._banKey(userId, ip);
    const count = (this.violations.get(key) || 0) + 1;
    this.violations.set(key, count);
    const banMs = Math.min(this.banMaxMs, this.banBaseMs * (2 ** Math.max(0, count - 1)));
    this.bans.set(key, Date.now() + banMs);
    logger.warn("security_violation", { kind, userId, ip, count, banMs, ...details });
    metrics.suspiciousTotal.inc({ event: kind });
    if (kind === "action_spam" || kind === "duplicate_action_flood") {
      void sendAlert("security_action_flood", { kind, userId, ip, count, ...details });
    }
    return { blocked: true, reason: "TEMP_BANNED", retryAfterMs: banMs };
  }

  onConnection(socket, userId) {
    const ip = this.getIp(socket);
    if (this._isBanned(userId, ip)) {
      return { blocked: true, reason: "TEMP_BANNED" };
    }
    const socketKey = `${socket.id}:${userId}:${ip}`;
    if (this.socketSeen.has(socketKey)) {
      return this._registerViolation("duplicate_socket_flood", userId, ip, { socketId: socket.id });
    }
    this.socketSeen.add(socketKey);
    const userOk = this._take("connect_user", userId, this.connectPerWindow, this.connectWindowMs);
    const ipOk = this._take("connect_ip", ip, this.connectPerWindow * 2, this.connectWindowMs);
    if (!userOk || !ipOk) {
      return this._registerViolation("rapid_reconnect_abuse", userId, ip);
    }
    return { blocked: false };
  }

  onDisconnect(socket, userId) {
    const ip = this.getIp(socket);
    this.socketSeen.delete(`${socket.id}:${userId}:${ip}`);
  }

  onAction(userId, ip, actionId) {
    if (this._isBanned(userId, ip)) return { blocked: true, reason: "TEMP_BANNED" };
    const userOk = this._take("action_user", userId, this.actionPerWindow, this.actionWindowMs);
    const ipOk = this._take("action_ip", ip, this.actionPerWindow * 2, this.actionWindowMs);
    if (!userOk || !ipOk) {
      return this._registerViolation("action_spam", userId, ip, { actionId });
    }
    if (actionId) {
      const dupKey = `${userId}:${actionId}`;
      const unique = this._take("dup_action", dupKey, 1, 60000);
      if (!unique) {
        return this._registerViolation("duplicate_action_flood", userId, ip, { actionId });
      }
    }
    return { blocked: false };
  }
}

class PokerTable {
  constructor(nsp, table, options = null) {
    this.nsp = nsp;
    this.tableId = String(table._id);
    this.smallBlind = toSafeInt(table.smallBlind, 0);
    this.bigBlind = toSafeInt(table.bigBlind, 0);
    this.minBuyIn = toSafeInt(table.minBuyIn, this.bigBlind * 100);
    this.maxBuyIn = toSafeInt(table.maxBuyIn, this.minBuyIn);
    this.buyIn = toSafeInt(table.buyIn ?? table.minBuyIn, this.minBuyIn);
    this.minimumBet = deriveMinimumBet(this.buyIn, table.minimumBet);
    this.capacity = normalizeCapacity(toSafeInt(table.capacity, 9));
    this.dealerIndex = 0;
    this.running = false;
    this.starting = false;

    this.turnTimer = null;
    this.botThinkTimer = null;
    this.botFillTimer = null;
    this.actionDeadline = null;
    this.botFillDeadline = null;
    this.waitForPlayersTimer = null;
    this.waitForPlayersDeadline = null;
    this.nextHandTimer = null;
    this.resetStateFromTable(table);
    this.turnSeconds = POKER_TIMINGS.TURN_SECONDS;
    this.reconnectTimers = new Map();
    this.pendingVacates = new Map();
    this.vacateTimers = new Map();
    this.spectatorUserIds = new Set();
    this.handStartTotal = 0;
    this.uncollectedRake = 0;
    this.frozen = false;
    this.tableStatusOverride = null;
    this.pacingBusy = false;

    this.botFillDelayMs = Math.max(
      3000,
      toSafeInt(process.env.POKER_BOT_FILL_DELAY_MS, 8000)
    );
    this.botFillTarget = clampInt(
      process.env.POKER_BOT_FILL_TARGET || POKER_CAPACITY,
      2,
      Math.max(2, this.capacity)
    );
    const defaultBotBuyIn = Math.max(this.minBuyIn, this.bigBlind * 120);
    this.botBuyIn = clampInt(
      process.env.POKER_BOT_BUY_IN || defaultBotBuyIn,
      Math.max(1, this.minBuyIn),
      Math.max(Math.max(1, this.minBuyIn), this.maxBuyIn || defaultBotBuyIn)
    );
    this.botSerial = 0;
    this.handCounter = 0;
    /** Monotonic id for showdown_end dedupe on clients. */
    this.showdownEndSeq = 0;
    this.lastHand = null;
    this.currentHandId = null;
    this.currentHandActions = [];
    this.lastRaiseAmount = this.bigBlind;
    this.processedActionIds = new Set();
    /** Monotonic: bumps on each snapshot persist; clients drop stale packets. */
    this.stateRevision = 0;
    this.serverSeed = null;
    this.serverSeedHash = null;
    this.clientSeedDigest = null;
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;
    this.handStartedAt = null;
    const lockArg = options && typeof options.acquire === "function"
      ? options
      : options?.lockManager;
    this.redis = options?.redis || null;
    // Pluggable lock manager; Redis-backed when available, in-memory otherwise.
    this.lockManager =
      lockArg ||
      (this.redis ? new RedisTableLockManager(this.redis) : new InMemoryTableLockManager());
    this.stateStore = options?.stateStore || new RedisTableStateStore(this.redis);
  }

  static get ROUND_TRANSITIONS() {
    return {
      idle: new Set(["preflop"]),
      preflop: new Set(["flop", "idle"]),
      flop: new Set(["turn", "idle"]),
      turn: new Set(["river", "idle"]),
      river: new Set(["showdown", "idle"]),
      showdown: new Set(["idle"]),
    };
  }

  setRound(nextRound) {
    const curr = this.round;
    if (curr === nextRound) return true;
    const allowed = PokerTable.ROUND_TRANSITIONS[curr] || new Set();
    if (!allowed.has(nextRound)) {
      console.warn(
        `[PokerTable:${this.tableId}] Illegal state transition blocked: ${curr} -> ${nextRound}`
      );
      return false;
    }
    this.round = nextRound;
    return true;
  }

  logSuspicious(event, details = {}) {
    metrics.suspiciousTotal.inc({ event });
    logger.warn("poker_suspicious", { tableId: this.tableId, event, ...details });
  }

  appendHandAction(entry) {
    if (!this.currentHandId) return;
    this.currentHandActions.push({
      ts: Date.now(),
      round: this.round,
      ...entry,
    });
  }

  recordSeatAction(seatIndex, type, amount = null) {
    const s = this.seats[seatIndex];
    if (!s) return;
    if (amount != null && Number.isFinite(amount)) {
      s.lastAction = { type: String(type), amount: toSafeInt(amount, 0) };
    } else {
      s.lastAction = { type: String(type) };
    }
  }

  /** Voluntary action this betting street (not blind post) — used with short-all-in no-reopen. */
  markVoluntaryAction(seatIndex) {
    const s = this.seats[seatIndex];
    if (s) s.actedThisStreet = true;
  }

  /**
   * Per-table action serialization (in-memory or Redis via lockManager).
   * Replace lockManager implementation for distributed locks without touching engine rules.
   */
  async acquireTableActionLock() {
    return this.acquireActionLock();
  }

  computeLastTableAction() {
    for (let i = this.currentHandActions.length - 1; i >= 0; i--) {
      const a = this.currentHandActions[i];
      if (!a || typeof a !== "object") continue;
      const t = String(a.type || "");
      if (t === "fold" || t === "call" || t === "check" || t === "raise") {
        return {
          type: t,
          seatIndex: toSafeInt(a.seatIndex, -1),
          playerId: a.playerId || null,
          amount: a.amount != null ? toSafeInt(a.amount, 0) : undefined,
          ts: a.ts,
          round: a.round,
        };
      }
    }
    return null;
  }

  async acquireActionLock() {
    return this.lockManager.acquire(this.tableId);
  }

  async releaseActionLock() {
    await this.lockManager.release(this.tableId);
  }

  actionIdempotencyKey(actionId) {
    return `poker:idem:table:${this.tableId}:hand:${this.currentHandId}:action:${actionId}`;
  }

  async claimActionId(actionId) {
    if (!actionId || String(actionId).trim().length === 0) return false;

    // Shared idempotency across instances when Redis exists.
    if (this.redis && this.currentHandId) {
      const ttlSec = toSafeInt(process.env.POKER_ACTION_IDEMPOTENCY_TTL_SEC, 7200);
      const ok = await this.redis.set(this.actionIdempotencyKey(actionId), "1", {
        NX: true,
        EX: ttlSec,
      });
      return ok === "OK";
    }

    // Fallback in-memory idempotency for single-instance mode.
    if (this.processedActionIds.has(actionId)) return false;
    this.processedActionIds.add(actionId);
    return true;
  }

  serializeSnapshot() {
    return {
      v: 1,
      tableId: this.tableId,
      stateRevision: toSafeInt(this.stateRevision, 0),
      capacity: this.capacity,
      savedAt: Date.now(),
      running: !!this.running,
      starting: !!this.starting,
      round: this.round,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      lastRaiseAmount: this.lastRaiseAmount,
      dealerIndex: this.dealerIndex,
      currentIndex: this.currentIndex,
      actionDeadline: this.actionDeadline,
      botFillDeadline: this.botFillDeadline,
      waitForPlayersDeadline: this.waitForPlayersDeadline,
      turnSeconds: this.turnSeconds,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buyIn: this.buyIn,
      minimumBet: this.minimumBet,
      sbSeatIndex: this.sbSeatIndex,
      bbSeatIndex: this.bbSeatIndex,
      community: [...this.community],
      deck: Array.isArray(this.deck) ? [...this.deck] : [],
      currentHandId: this.currentHandId,
      serverSeedHash: this.serverSeedHash,
      clientSeedDigest: this.clientSeedDigest,
      currentHandActions: [...this.currentHandActions],
      processedActionIds: [...this.processedActionIds],
      lastHand: this.lastHand,
      shortAllInNoReopen: !!this.shortAllInNoReopen,
      showdownRevealedSeats: [...this.showdownRevealedSeats],
      seats: this.seats.map((s) => ({
        userId: s.userId,
        name: s.name,
        avatar: s.avatar,
        chips: s.chips,
        inHand: s.inHand,
        hole: Array.isArray(s.hole) ? [...s.hole] : [],
        folded: s.folded,
        allIn: s.allIn,
        bet: s.bet,
        invested: s.invested,
        isBot: !!s.isBot,
        handStartChips: toSafeInt(s.handStartChips, s.chips),
        lastAction: s.lastAction && typeof s.lastAction === "object" ? { ...s.lastAction } : null,
        actedThisStreet: !!s.actedThisStreet,
        playerState: s.playerState || PLAYER_STATE.SEATED,
        disconnectedAt: s.disconnectedAt || null,
        reconnectDeadline: s.reconnectDeadline || null,
        cosmetics:
          s.cosmetics && typeof s.cosmetics === "object"
            ? { ...s.cosmetics }
            : { tableTheme: null, cardSkin: null },
      })),
      actionSpec: this.computeTurnActionSpec(this.currentIndex),
      lastAction: this.computeLastTableAction(),
    };
  }

  restoreFromSnapshot(snapshot) {
    if (!snapshot || String(snapshot.tableId) !== String(this.tableId)) return false;

    this.running = !!snapshot.running;
    this.starting = false;
    this.round = String(snapshot.round || "idle");
    this.pot = toSafeInt(snapshot.pot, 0);
    this.currentBet = toSafeInt(snapshot.currentBet, 0);
    this.minRaise = toSafeInt(snapshot.minRaise, this.bigBlind);
    this.lastRaiseAmount = toSafeInt(snapshot.lastRaiseAmount, this.bigBlind);
    this.dealerIndex = toSafeInt(snapshot.dealerIndex, 0);
    this.currentIndex = toSafeInt(snapshot.currentIndex, 0);
    this.actionDeadline = snapshot.actionDeadline || null;
    this.botFillDeadline = snapshot.botFillDeadline || null;
    this.waitForPlayersDeadline = snapshot.waitForPlayersDeadline || null;
    this.turnSeconds = toSafeInt(snapshot.turnSeconds, this.turnSeconds);
    this.smallBlind = toSafeInt(snapshot.smallBlind, this.smallBlind);
    this.bigBlind = toSafeInt(snapshot.bigBlind, this.bigBlind);
    this.buyIn = toSafeInt(snapshot.buyIn, this.buyIn || this.minBuyIn);
    this.minimumBet = toSafeInt(snapshot.minimumBet, deriveMinimumBet(this.buyIn));
    this.sbSeatIndex = toSafeInt(snapshot.sbSeatIndex, -1);
    this.bbSeatIndex = toSafeInt(snapshot.bbSeatIndex, -1);
    this.community = Array.isArray(snapshot.community) ? [...snapshot.community] : [];
    this.deck = Array.isArray(snapshot.deck) ? [...snapshot.deck] : [];
    this.currentHandId = snapshot.currentHandId || null;
    this.serverSeedHash = snapshot.serverSeedHash || null;
    this.clientSeedDigest = snapshot.clientSeedDigest || null;
    this.currentHandActions = Array.isArray(snapshot.currentHandActions)
      ? [...snapshot.currentHandActions]
      : [];
    this.processedActionIds = new Set(
      Array.isArray(snapshot.processedActionIds) ? snapshot.processedActionIds : []
    );
    this.stateRevision = toSafeInt(snapshot.stateRevision, 0);
    this.lastHand = snapshot.lastHand || null;
    this.shortAllInNoReopen = !!snapshot.shortAllInNoReopen;
    this.showdownRevealedSeats = new Set(
      Array.isArray(snapshot.showdownRevealedSeats) ? snapshot.showdownRevealedSeats : []
    );
    // actionSpec / lastAction in snapshot are for subscribers; live table recomputes each tick.

    const restoredSeats = Array.isArray(snapshot.seats) ? snapshot.seats : [];
    if (restoredSeats.length > 0) {
      this.seats = restoredSeats.map((s) => ({
        userId: String(s.userId),
        name: s.name || "Player",
        avatar: s.avatar || null,
        chips: toSafeInt(s.chips, 0),
        inHand: !!s.inHand,
        hole: Array.isArray(s.hole) ? [...s.hole] : [],
        folded: !!s.folded,
        allIn: !!s.allIn,
        bet: toSafeInt(s.bet, 0),
        invested: toSafeInt(s.invested, 0),
        isBot: !!s.isBot,
        handStartChips: toSafeInt(s.handStartChips, toSafeInt(s.chips, 0)),
        lastAction: s.lastAction && typeof s.lastAction === "object" ? { ...s.lastAction } : null,
        actedThisStreet: !!s.actedThisStreet,
        playerState: s.playerState || PLAYER_STATE.SEATED,
        disconnectedAt: s.disconnectedAt || null,
        reconnectDeadline: s.reconnectDeadline || null,
        cosmetics:
          s.cosmetics && typeof s.cosmetics === "object"
            ? { tableTheme: s.cosmetics.tableTheme || null, cardSkin: s.cosmetics.cardSkin || null }
            : { tableTheme: null, cardSkin: null },
      }));
      if (this.seats.length > 0) {
        this.dealerIndex =
          ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
        this.currentIndex =
          ((this.currentIndex % this.seats.length) + this.seats.length) % this.seats.length;
      }
    }

    this.clearActionScheduling();
    if (this.running) {
      this.scheduleCurrentTurn();
    } else {
      this.rescheduleWaitForPlayersAfterRestore();
    }
    return true;
  }

  /**
   * After crash/restart the deadline may be restored without an active timer.
   */
  rescheduleWaitForPlayersAfterRestore() {
    if (this.running || this.frozen || this.round !== "idle") return;
    if (this.waitForPlayersTimer) return;
    const deadline = this.waitForPlayersDeadline;
    if (!deadline) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.waitForPlayersDeadline = null;
      void this.onWaitForPlayersWindowEnd();
      return;
    }
    this.waitForPlayersTimer = setTimeout(() => {
      void this.onWaitForPlayersWindowEnd();
    }, remaining);
  }

  /**
   * Recover idle tables stuck in a mid-hand round after an unclean shutdown.
   */
  healStaleRoundIfNotRunning() {
    if (this.running || this.round === "idle") return;
    this.logSuspicious("heal_stale_round", { round: this.round });
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;
    this.currentHandId = null;
    this.currentHandActions = [];
    this.processedActionIds = new Set();
    this.clearActionScheduling();
    this.clearBotFillTimer();
    this.clearWaitForPlayersTimer();
    for (const s of this.seats) {
      s.inHand = false;
      s.hole = [];
      s.folded = false;
      s.allIn = false;
      s.bet = 0;
      s.invested = 0;
      s.actedThisStreet = false;
      if (s.chips > 0 && s.playerState === PLAYER_STATE.ACTIVE_HAND) {
        s.playerState = PLAYER_STATE.SEATED;
      }
    }
    this.round = "idle";
  }

  async reconcileEngineWithMongo(tableDoc) {
    const mongoHumans = (tableDoc?.seats || []).filter(
      (s) => toSafeInt(s.chips, 0) > 0
    ).length;
    const engineHumans = this.humanSeatCount();

    if (!this.running) {
      if (mongoHumans > 0 && engineHumans === 0) {
        await this.refreshSeatsFromDb();
        if (this.stateStore?.delete) {
          await this.stateStore.delete(this.tableId);
        }
      } else if (mongoHumans === 0 && engineHumans > 0) {
        this.resetStateFromTable(tableDoc || { seats: [] });
        if (this.stateStore?.delete) {
          await this.stateStore.delete(this.tableId);
        }
      }
      if (this.round !== "idle") {
        this.healStaleRoundIfNotRunning();
      }
    }
  }

  static publicStateFromSnapshot(snapshot, forUserId) {
    if (!snapshot || !Array.isArray(snapshot.seats)) return null;
    const seats = snapshot.seats;
    const currentIndex = toSafeInt(snapshot.currentIndex, 0);
    const turnUserId = seats[currentIndex]?.userId || null;
    const isActor =
      forUserId != null && turnUserId != null && String(forUserId) === String(turnUserId);
    const rawSpec = isActor ? snapshot.actionSpec || null : null;
    const actionSpec = normalizeClientActionSpec(rawSpec, isActor);
    const lobby = buildPokerLobbyFields({
      engineSeats: seats,
      capacity: snapshot.capacity || POKER_CAPACITY,
      running: !!snapshot.running,
      round: snapshot.round,
    });

    return {
      tableId: String(snapshot.tableId),
      stateRevision: toSafeInt(snapshot.stateRevision, 0),
      round: String(snapshot.round || "idle"),
      ...lobby,
      community: Array.isArray(snapshot.community) ? snapshot.community : [],
      pot: toSafeInt(snapshot.pot, 0),
      currentBet: toSafeInt(snapshot.currentBet, 0),
      minRaise: toSafeInt(snapshot.minRaise, 0),
      lastRaiseAmount: toSafeInt(snapshot.lastRaiseAmount, 0),
      smallBlind: toSafeInt(snapshot.smallBlind, 0),
      bigBlind: toSafeInt(snapshot.bigBlind, 0),
      sbSeatIndex: toSafeInt(snapshot.sbSeatIndex, -1),
      bbSeatIndex: toSafeInt(snapshot.bbSeatIndex, -1),
      dealerSeatIndex: toSafeInt(snapshot.dealerIndex, 0),
      turnUserId,
      actionDeadline: snapshot.actionDeadline || null,
      botFillDeadline: snapshot.botFillDeadline || null,
      waitForPlayersDeadline: snapshot.waitForPlayersDeadline || null,
      waitForPlayersSeconds: Math.ceil(POKER_TIMINGS.WAIT_FOR_PLAYERS_MS / 1000),
      lastHand: snapshot.lastHand || null,
      actionSpec,
      lastAction:
        snapshot.lastAction && typeof snapshot.lastAction === "object"
          ? { ...snapshot.lastAction }
          : null,
      seats: seats.map((s, i) => ({
        seatIndex: i,
        seatPosition: toSafeInt(s.seatPosition, i),
        userId: s.userId,
        name: s.name,
        avatar: s.avatar,
        isBot: !!s.isBot,
        chips: toSafeInt(s.chips, 0),
        inHand: !!s.inHand,
        folded: !!s.folded,
        allIn: !!s.allIn,
        hole: mapHoleForClientView({
          round: snapshot.round,
          lastHand: snapshot.lastHand,
          seat: s,
          seatIndex: i,
          forUserId,
          showdownRevealedSeats: new Set(
            Array.isArray(snapshot.showdownRevealedSeats) ? snapshot.showdownRevealedSeats : []
          ),
        }),
        bet: toSafeInt(s.bet, 0),
        lastAction: s.lastAction && typeof s.lastAction === "object" ? { ...s.lastAction } : null,
        cosmetics:
          s.cosmetics && typeof s.cosmetics === "object"
            ? {
                tableTheme: s.cosmetics.tableTheme || null,
                cardSkin: s.cosmetics.cardSkin || null,
              }
            : { tableTheme: null, cardSkin: null },
      })),
    };
  }

  async saveSnapshot({ finished = false } = {}) {
    this.stateRevision = toSafeInt(this.stateRevision, 0) + 1;
    if (!this.stateStore || !this.stateStore.isEnabled()) return;
    const snapshot = this.serializeSnapshot();
    await this.stateStore.save(this.tableId, snapshot, { finished });
  }

  clearTurnTimer() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
  }

  clearBotThinkTimer() {
    if (this.botThinkTimer) {
      clearTimeout(this.botThinkTimer);
      this.botThinkTimer = null;
    }
  }

  clearBotFillTimer() {
    if (this.botFillTimer) {
      clearTimeout(this.botFillTimer);
      this.botFillTimer = null;
    }
    this.botFillDeadline = null;
  }

  clearWaitForPlayersTimer() {
    if (this.waitForPlayersTimer) {
      clearTimeout(this.waitForPlayersTimer);
      this.waitForPlayersTimer = null;
    }
    this.waitForPlayersDeadline = null;
  }

  clearNextHandTimer() {
    if (this.nextHandTimer) {
      clearTimeout(this.nextHandTimer);
      this.nextHandTimer = null;
    }
  }

  scheduleNextHand() {
    this.clearNextHandTimer();
    const delay = POKER_TIMINGS.NEXT_HAND_DELAY_MS;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      void this.beginNextHandIfPossible();
    }, delay);
  }

  async beginNextHandIfPossible() {
    if (this.frozen && !this.running) {
      const probe = auditChipConservation(this, "unfreeze_probe");
      if (probe.ok) {
        this.frozen = false;
        this.tableStatusOverride = null;
      }
    }
    if (this.frozen || this.running || this.starting) return;
    if (this.round !== "idle") {
      if (!this.running) this.healStaleRoundIfNotRunning();
      if (this.round !== "idle") return;
    }

    promoteWaitingToSeated(this.seats);
    this.seats = this.seats.filter((s) => s.chips > 0);
    if (this.seats.length > 0) {
      this.dealerIndex =
        ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
    }

    if (this.humanSeatCount() >= 1 && this.activeSeatCount() < this.botFillTarget) {
      this.addBotsForMissingSeats();
    }

    if (this.humanSeatCount() < 1) {
      this.scheduleWaitForPlayers();
      await this.broadcastState();
      return;
    }

    await this.startIfReady({ refreshFromDb: false, allowBotFill: true });
  }

  scheduleWaitForPlayers() {
    if (this.running || this.frozen) return;
    if (this.eligibleHumanCount() >= POKER_MIN_PLAYERS) {
      this.clearWaitForPlayersTimer();
      void this.startIfReady({ refreshFromDb: false, allowBotFill: true });
      return;
    }
    if (this.waitForPlayersTimer) return;

    this.waitForPlayersDeadline = Date.now() + POKER_TIMINGS.WAIT_FOR_PLAYERS_MS;
    this.waitForPlayersTimer = setTimeout(() => {
      void this.onWaitForPlayersWindowEnd();
    }, POKER_TIMINGS.WAIT_FOR_PLAYERS_MS);
  }

  async onWaitForPlayersWindowEnd() {
    this.waitForPlayersTimer = null;
    if (this.running || this.frozen) {
      this.clearWaitForPlayersTimer();
      return;
    }

    if (this.eligibleHumanCount() >= POKER_MIN_PLAYERS) {
      this.clearWaitForPlayersTimer();
      await this.startIfReady({ refreshFromDb: true });
      return;
    }

    // At least 1 human is seated but not enough humans for a normal start.
    // Fill the remaining seats with bots and start immediately.
    if (this.humanSeatCount() >= 1) {
      this.addBotsForMissingSeats();
      await this.broadcastState();
      await this.startIfReady({ refreshFromDb: false, allowBotFill: true });
      return;
    }

    // No humans at all — restart the wait window and keep the table warm.
    this.waitForPlayersDeadline = Date.now() + POKER_TIMINGS.WAIT_FOR_PLAYERS_MS;
    this.waitForPlayersTimer = setTimeout(() => {
      void this.onWaitForPlayersWindowEnd();
    }, POKER_TIMINGS.WAIT_FOR_PLAYERS_MS);
    await this.broadcastState();
  }

  clearActionScheduling() {
    this.clearTurnTimer();
    this.clearBotThinkTimer();
    this.actionDeadline = null;
  }

  compareRank(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.cat !== b.cat) return a.cat - b.cat;
    const at = Array.isArray(a.tiebreak) ? a.tiebreak : [];
    const bt = Array.isArray(b.tiebreak) ? b.tiebreak : [];
    for (let i = 0; i < Math.max(at.length, bt.length); i++) {
      const av = at[i] || 0;
      const bv = bt[i] || 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }

  async applyJackpotPayout(winnerIdxs) {
    if (!winnerIdxs || winnerIdxs.length === 0) return;
    try {
      const j = await Jackpot.getSingleton();
      if (!j || (j.pot || 0) <= 0) return;
      // Determine highest qualifying hand type among winners
      let type = null; // 'royalFlush' | 'straightFlush' | 'fullHouse'
      const qualified = [];
      for (const i of winnerIdxs) {
        if (this.seats[i]?.isBot) continue;
        const rank = bestOf7([...this.seats[i].hole, ...this.community]);
        if (rank.cat === 8) {
          // Straight flush; royal if high is Ace (14)
          const isRoyal = (rank.tiebreak && rank.tiebreak[0] === 14);
          const t = isRoyal ? 'royalFlush' : 'straightFlush';
          // Prefer higher category
          if (type !== 'royalFlush') {
            type = t;
          }
          qualified.push({ i, type: t });
        } else if (rank.cat === 6) {
          if (!type) type = 'fullHouse';
          qualified.push({ i, type: 'fullHouse' });
        }
      }

      if (!type) return; // no qualifying hand

      const factor = type === 'royalFlush' ? (j.payouts?.royalFlush || 1.0)
        : type === 'straightFlush' ? (j.payouts?.straightFlush || 0.8)
        : (j.payouts?.fullHouse || 0.3);

      let amount = Math.floor((j.pot || 0) * factor);
      if (amount <= 0) return;

      // Winners that match the selected highest type
      const winners = qualified.filter((q) => q.type === type).map((q) => q.i);
      const share = Math.max(0, Math.floor(amount / winners.length));
      if (share <= 0) return;

      for (const wi of winners) {
        const userId = this.seats[wi].userId;
        if (!userId || isBotUserId(userId)) continue;
        let wallet = await Wallet.findOne({ user: userId });
        if (!wallet) wallet = await Wallet.create({ user: userId });
        await wallet.addTransaction('credit', share, `Golden Island jackpot (${type})`);
      }

      j.pot = Math.max(0, (j.pot || 0) - (share * winners.length));
      await j.save();
    } catch (e) {
      // ignore jackpot payout errors to not block gameplay
    }
  }

  resetStateFromTable(table) {
    this.smallBlind = toSafeInt(table.smallBlind, this.smallBlind);
    this.bigBlind = toSafeInt(table.bigBlind, this.bigBlind);
    this.capacity = normalizeCapacity(toSafeInt(table.capacity, this.capacity || POKER_CAPACITY));
    this.minBuyIn = toSafeInt(table.minBuyIn, this.minBuyIn || this.bigBlind * 100);
    this.maxBuyIn = toSafeInt(table.maxBuyIn, this.maxBuyIn || this.minBuyIn);
    this.buyIn = toSafeInt(table.buyIn ?? table.minBuyIn, this.buyIn || this.minBuyIn);
    this.minimumBet = deriveMinimumBet(this.buyIn, table.minimumBet ?? this.minimumBet);
    this.botFillTarget = clampInt(this.botFillTarget || 2, 2, Math.max(2, this.capacity));

    const isHandRunning = this.running && this.round && String(this.round) !== "idle";
    const seatDefaults = createSeatDefaults({ isHandRunning });

    const mapped = [];
    const usedChair = new Set();
    for (const s of sortSeatsByPosition(table.seats)) {
      if (toSafeInt(s.chips, 0) <= 0) continue;
      let chair = s.seatPosition;
      if (chair == null) {
        chair = nextFreeSeatPosition(
          mapped.map((m) => ({ seatPosition: m.seatPosition })),
          this.capacity
        );
      }
      if (chair == null) chair = mapped.length;
      usedChair.add(chair);
      mapped.push({
        userId: String(s.user?._id || s.user),
        name: s.user?.name || "Player",
        avatar: s.user?.profileImg || null,
        chips: toSafeInt(s.chips, 0),
        inHand: false,
        hole: [],
        folded: false,
        allIn: false,
        bet: 0,
        invested: 0,
        isBot: false,
        lastAction: null,
        actedThisStreet: false,
        seatPosition: chair,
        cosmetics: { tableTheme: null, cardSkin: null },
        playerState: seatDefaults.playerState,
        disconnectedAt: null,
        reconnectDeadline: null,
      });
    }
    this.seats = mapped.slice(0, this.capacity);

    if (this.seats.length > 0) {
      this.dealerIndex = ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
    } else {
      this.dealerIndex = 0;
    }

    this.community = [];
    this.pot = 0;
    this.round = "idle"; // idle|preflop|flop|turn|river|showdown
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;
    this.currentIndex = 0;
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;
    this.shortAllInNoReopen = false;
    this.showdownRevealedSeats = new Set();
  }

  /**
   * Full zero when Mongo has no seated players — pot/cards/timers cleared.
   */
  async resetToEmptyIdle(tableDoc) {
    this.running = false;
    this.starting = false;
    this.frozen = false;
    this.tableStatusOverride = null;
    this.clearActionScheduling();
    this.clearBotFillTimer();
    this.clearWaitForPlayersTimer();
    this.clearNextHandTimer();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const timer of this.vacateTimers.values()) {
      clearTimeout(timer);
    }
    this.vacateTimers.clear();
    this.pendingVacates.clear();

    this.currentHandId = null;
    this.currentHandActions = [];
    this.processedActionIds = new Set();
    this.handStartTotal = 0;
    this.uncollectedRake = 0;
    this.lastHand = null;
    this.handCounter = 0;
    this.showdownEndSeq = 0;
    this.deck = [];

    const doc =
      tableDoc ||
      ({
        seats: [],
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        minBuyIn: this.minBuyIn,
        maxBuyIn: this.maxBuyIn,
        capacity: this.capacity,
      });
    this.resetStateFromTable(doc);
    this.stateRevision = toSafeInt(this.stateRevision, 0) + 1;

    if (this.stateStore && typeof this.stateStore.delete === "function") {
      await this.stateStore.delete(this.tableId);
    }
    await this.syncMongoTableStatus();
    await this.broadcastState();
  }

  async refreshSeatsFromDb() {
    const prevByUser = new Map(this.seats.map((s) => [String(s.userId), s]));
    const previousBots = this.seats
      .filter((s) => s.isBot && s.chips > 0)
      .map((b) => ({
        ...b,
        inHand: false,
        hole: [],
        folded: false,
        allIn: false,
        bet: 0,
        invested: 0,
        actedThisStreet: false,
      }));

    const handActive = this.running && this.round && String(this.round) !== "idle";

    const table = await Table.findById(this.tableId).populate({
      path: "seats.user",
      select: "name profileImg",
    });
    if (!table) return false;

    if (handActive) {
      const mongoIds = new Set(table.seats.map((s) => String(s.user?._id || s.user)));
      for (const s of this.seats) {
        if (!mongoIds.has(String(s.userId)) && !s.isBot) {
          s.chips = 0;
        }
      }
      for (const ms of table.seats) {
        const uid = String(ms.user?._id || ms.user);
        if (this.findSeatIndexByUser(uid) >= 0) continue;
        const row = {
          userId: uid,
          name: ms.user?.name || "Player",
          avatar: ms.user?.profileImg || null,
          chips: toSafeInt(ms.chips, 0),
          inHand: false,
          hole: [],
          folded: true,
          allIn: false,
          bet: 0,
          invested: 0,
          isBot: false,
          lastAction: null,
          actedThisStreet: false,
          cosmetics: { tableTheme: null, cardSkin: null },
          playerState: PLAYER_STATE.WAITING,
          disconnectedAt: null,
          reconnectDeadline: null,
        };
        if (this.seats.length < this.capacity) {
          this.seats.push(row);
        }
      }
      await this.applyCosmeticsToSeats();
      return true;
    }

    this.resetStateFromTable(table);
    for (const s of this.seats) {
      const prev = prevByUser.get(String(s.userId));
      if (prev) {
        s.playerState = prev.playerState || s.playerState;
        s.disconnectedAt = prev.disconnectedAt;
        s.reconnectDeadline = prev.reconnectDeadline;
      }
    }
    await this.applyCosmeticsToSeats();

    const shouldRestoreBots =
      this.humanSeatCount() >= 1 &&
      this.activeSeatCount() < Math.min(this.capacity, Math.max(2, this.botFillTarget));
    if (shouldRestoreBots && previousBots.length > 0) {
      const target = Math.min(this.capacity, Math.max(2, this.botFillTarget));
      const missing = Math.max(0, target - this.activeSeatCount());
      const freeSlots = Math.max(0, this.capacity - this.seats.length);
      const toRestore = Math.min(missing, freeSlots, previousBots.length);
      if (toRestore > 0) {
        this.seats.push(...previousBots.slice(0, toRestore));
      }
    }

    return true;
  }

  async applyCosmeticsToSeats() {
    const humanIds = this.seats
      .filter((s) => s.userId && !s.isBot && !isBotUserId(String(s.userId)))
      .map((s) => String(s.userId));
    if (humanIds.length === 0) {
      for (const s of this.seats) {
        if (!s.cosmetics) s.cosmetics = { tableTheme: null, cardSkin: null };
        s.vipLevel = null;
      }
      return;
    }
    const map = await cosmeticsService.resolveEquippedPayloadForUsers(humanIds);
    const vipMap = await vipService.getVipLevelsForUsers(humanIds);
    for (const s of this.seats) {
      if (s.isBot || isBotUserId(String(s.userId))) {
        s.cosmetics = { tableTheme: null, cardSkin: null };
        s.vipLevel = null;
        continue;
      }
      const c = map.get(String(s.userId));
      s.cosmetics = c ? { ...c } : { tableTheme: null, cardSkin: null };
      s.vipLevel = vipMap.get(String(s.userId)) || null;
    }
  }

  findSeatIndexByUser(userId) {
    return this.seats.findIndex((s) => String(s.userId) === String(userId));
  }

  activeSeatCount() {
    return this.seats.filter((s) => s.chips > 0).length;
  }

  humanSeatCount() {
    return this.seats.filter((s) => !s.isBot && s.chips > 0).length;
  }

  eligibleHumanCount() {
    return countEligibleHumans(this.seats);
  }

  applyMidHandJoinState(seat) {
    if (!seat) return;
    if (this.running && this.round && String(this.round) !== "idle") {
      seat.playerState = PLAYER_STATE.WAITING;
      seat.inHand = false;
      seat.hole = [];
      seat.folded = true;
    } else {
      seat.playerState = PLAYER_STATE.SEATED;
    }
  }

  clearVacateTimer(userId) {
    const key = String(userId);
    const t = this.vacateTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.vacateTimers.delete(key);
    }
  }

  /**
   * Engine-only vacate after Mongo moved human → vacatingPlayers.
   */
  async applyEngineVacate(userId, { chips, vacateUntil } = {}) {
    const uid = String(userId);
    if (this.pendingVacates.has(uid)) return false;

    const idx = this.findSeatIndexByUser(uid);
    let seatChips = toSafeInt(chips, 0);
    let seatIndex = idx >= 0 ? idx : this.seats.length;
    let name = "Player";
    let avatar = null;
    let cosmetics = { tableTheme: null, cardSkin: null };

    if (idx >= 0) {
      const seat = this.seats[idx];
      seatChips = toSafeInt(chips, toSafeInt(seat.chips, 0));
      name = seat.name;
      avatar = seat.avatar;
      cosmetics = seat.cosmetics;
      seatIndex = idx;

      if (seat.inHand && this.running && !seat.folded) {
        seat.folded = true;
        await this.broadcastState();
        if (this.currentIndex === idx) {
          await this.advance();
        }
      }
      this.clearReconnectTimer(uid);
      this.seats.splice(idx, 1);
      if (this.seats.length > 0) {
        this.dealerIndex =
          ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
      } else {
        this.dealerIndex = 0;
      }
    } else if (seatChips <= 0) {
      return false;
    } else {
      this.clearReconnectTimer(uid);
    }

    const deadlineMs = vacateUntil
      ? new Date(vacateUntil).getTime()
      : Date.now() + POKER_TIMINGS.VACATE_WINDOW_MS;
    const delayMs = Math.max(0, deadlineMs - Date.now());

    this.pendingVacates.set(uid, {
      chips: seatChips,
      name,
      avatar,
      seatIndex,
      deadline: deadlineMs,
      cosmetics,
    });

    this.clearVacateTimer(uid);
    const timer = setTimeout(() => {
      void this.onVacateExpired(uid);
    }, delayMs);
    this.vacateTimers.set(uid, timer);

    if (this.eligibleHumanCount() < POKER_MIN_PLAYERS) {
      this.scheduleWaitForPlayers();
    }
    await this.syncMongoTableStatus();
    await this.broadcastState();
    return true;
  }

  /**
   * Permanent leave — remove human from engine without vacate/reconnect window.
   */
  async removeLiveHumanSeat(userId) {
    const uid = String(userId);
    this.clearVacateTimer(uid);
    this.clearReconnectTimer(uid);
    this.pendingVacates.delete(uid);

    const idx = this.findSeatIndexByUser(uid);
    if (idx >= 0) {
      const seat = this.seats[idx];
      if (seat.inHand && this.running && !seat.folded && !seat.allIn) {
        seat.folded = true;
        await this.broadcastState();
        if (this.currentIndex === idx) {
          await this.advance();
        }
      }
      this.seats.splice(idx, 1);
      if (this.seats.length > 0) {
        this.dealerIndex =
          ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
      } else {
        this.dealerIndex = 0;
      }
    }

    if (this.humanSeatCount() < 1) {
      // Last human left the table: never let the bots keep the hand (and the
      // table) alive on their own. Abort any in-progress bot-only hand, drop
      // the bots and go idle so the caller can reset the table immediately.
      this.clearActionScheduling();
      this.clearNextHandTimer();
      this.clearWaitForPlayersTimer();
      this.clearBotFillTimer();
      this.running = false;
      this.starting = false;
      this.round = "idle";
      this.seats = [];
      this.dealerIndex = 0;
      this.pot = 0;
      this.currentBet = 0;
      this.currentHandId = null;
      this.currentHandActions = [];
      this.processedActionIds = new Set();
    }

    await this.syncMongoTableStatus();
    await this.broadcastState();
    return true;
  }

  async restoreVacatedHumanSeat(userId, { chips } = {}) {
    const uid = String(userId);
    const pending = this.pendingVacates.get(uid);
    this.clearVacateTimer(uid);
    this.pendingVacates.delete(uid);

    if (this.findSeatIndexByUser(uid) >= 0) return false;

    const table = await Table.findById(this.tableId).populate({
      path: "seats.user",
      select: "name profileImg",
    });
    const ms = table?.seats?.find((s) => String(s.user?._id || s.user) === uid);
    const seatChips = toSafeInt(chips, toSafeInt(ms?.chips, pending?.chips || 0));

    const row = {
      userId: uid,
      name: ms?.user?.name || pending?.name || "Player",
      avatar: ms?.user?.profileImg || pending?.avatar || null,
      chips: seatChips,
      inHand: false,
      hole: [],
      folded: false,
      allIn: false,
      bet: 0,
      invested: 0,
      isBot: false,
      lastAction: null,
      actedThisStreet: false,
      cosmetics: pending?.cosmetics || { tableTheme: null, cardSkin: null },
      playerState: PLAYER_STATE.SEATED,
      disconnectedAt: null,
      reconnectDeadline: null,
    };

    const insertAt = Math.min(
      pending?.seatIndex != null ? pending.seatIndex : this.seats.length,
      this.seats.length
    );
    this.seats.splice(insertAt, 0, row);
    if (this.seats.length > 0) {
      this.dealerIndex = ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
    }

    this.clearWaitForPlayersTimer();
    await this.applyCosmeticsToSeats();
    if (this.humanSeatCount() >= 1 && this.activeSeatCount() < this.botFillTarget) {
      this.addBotsForMissingSeats();
    }
    await this.bootstrapLobbyStart();
    return true;
  }

  async onVacateExpired(userId) {
    const uid = String(userId);
    this.vacateTimers.delete(uid);
    const pending = this.pendingVacates.get(uid);
    if (!pending) return;
    if (!mongoose.isValidObjectId(this.tableId)) return;

    this.pendingVacates.delete(uid);

    const { finalizeVacateWithBot } = require("../services/pokerVacateService");
    const result = await finalizeVacateWithBot({
      tableId: this.tableId,
      userId: uid,
      chips: pending.chips,
    });
    if (!result.ok) return;

    const bot = this.createBotSeat();
    bot.chips = pending.chips;
    const insertAt = Math.min(pending.seatIndex, this.seats.length);
    this.seats.splice(insertAt, 0, bot);

    await this.startIfReady({ refreshFromDb: false });
    await this.broadcastState();
  }

  clearReconnectTimer(userId) {
    const key = String(userId);
    const t = this.reconnectTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.reconnectTimers.delete(key);
    }
  }

  onPlayerSocketConnected(userId) {
    const idx = this.findSeatIndexByUser(userId);
    if (idx < 0) return;
    const seat = this.seats[idx];
    this.clearReconnectTimer(userId);
    seat.disconnectedAt = null;
    seat.reconnectDeadline = null;
    if (seat.playerState === PLAYER_STATE.DISCONNECTED) {
      seat.playerState = seat.inHand ? PLAYER_STATE.ACTIVE_HAND : PLAYER_STATE.SEATED;
    }
    if (seat.playerState === PLAYER_STATE.SITTING_OUT && seat.chips > 0) {
      seat.playerState = PLAYER_STATE.SEATED;
    }
    void this.resyncTurnAfterReconnect(userId);
  }

  /**
   * Unstick turn timer after app kill / socket drop: enforce overdue timeout or reschedule.
   */
  async resyncTurnAfterReconnect(userId) {
    if (!this.running || this.frozen) return;

    const actorIdx = this.currentIndex;
    const actor = this.seats[actorIdx];
    if (
      !actor ||
      actor.isBot ||
      !actor.inHand ||
      actor.folded ||
      actor.allIn ||
      actor.chips <= 0
    ) {
      return;
    }

    const now = Date.now();
    if (this.actionDeadline != null && this.actionDeadline <= now) {
      await this.handleTimeout();
      return;
    }
    if (!this.turnTimer && !this.botThinkTimer) {
      this.scheduleCurrentTurn();
    }
  }

  onPlayerSocketDisconnected(userId) {
    const idx = this.findSeatIndexByUser(userId);
    if (idx < 0) return;
    const seat = this.seats[idx];
    if (seat.isBot) return;
    this.clearReconnectTimer(userId);
    seat.disconnectedAt = Date.now();
    seat.reconnectDeadline = seat.disconnectedAt + POKER_TIMINGS.RECONNECT_WINDOW_MS;
    seat.playerState = PLAYER_STATE.DISCONNECTED;
    const uid = String(userId);
    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(uid);
      const lockAcquired = await this.acquireActionLock();
      if (!lockAcquired) return; // table busy — skip; turn timer will handle the fold
      try {
        const i = this.findSeatIndexByUser(uid);
        if (i < 0) return;
        const s = this.seats[i];
        if (s.playerState !== PLAYER_STATE.DISCONNECTED) return;
        s.playerState = PLAYER_STATE.SITTING_OUT;
        if (s.inHand && this.running) {
          s.folded = true;
          await this.broadcastState();
          if (this.currentIndex === i) {
            await this.advance();
          }
        } else {
          await this.broadcastState();
        }
      } finally {
        await this.releaseActionLock();
      }
    }, POKER_TIMINGS.RECONNECT_WINDOW_MS);
    this.reconnectTimers.set(uid, timer);
    void this.broadcastState();
  }

  assertChipConservation(context) {
    const check = verifyHandChipConservation({
      seats: this.seats,
      pot: this.pot,
      handStartTotal: this.handStartTotal,
    });
    if (!check.ok) {
      this.logSuspicious("chip_conservation_violation", { context, ...check });
    }
    return check.ok;
  }

  async auditChipConservation(context) {
    return auditOrFreeze(this, context);
  }

  createBotSeat() {
    this.botSerial += 1;
    const userId = `bot:${this.tableId}:${Date.now()}:${this.botSerial}`;
    const chair =
      nextFreeSeatPosition(this.seats, this.capacity) ??
      POKER_OPPOSITE_DEALER_SEAT;
    return {
      userId,
      name: `Bot ${this.botSerial}`,
      avatar: null,
      chips: this.botBuyIn,
      inHand: false,
      hole: [],
      folded: false,
      allIn: false,
      bet: 0,
      invested: 0,
      isBot: true,
      lastAction: null,
      actedThisStreet: false,
      seatPosition: chair,
      cosmetics: { tableTheme: null, cardSkin: null },
    };
  }

  addBotsForMissingSeats() {
    this.seats = this.seats.filter((s) => s.chips > 0);
    if (this.seats.length > 0) {
      this.dealerIndex = ((this.dealerIndex % this.seats.length) + this.seats.length) % this.seats.length;
    } else {
      this.dealerIndex = 0;
    }

    const humans = this.humanSeatCount();
    if (humans <= 0) return 0;

    const target = Math.min(this.capacity, Math.max(2, this.botFillTarget));
    const active = this.activeSeatCount();
    const missing = Math.max(0, target - active);
    const freeSlots = Math.max(0, this.capacity - this.seats.length);
    const toAdd = Math.min(missing, freeSlots);
    if (toAdd === 0) return 0;

    for (let i = 0; i < toAdd; i++) {
      this.seats.push(this.createBotSeat());
    }
    return toAdd;
  }

  scheduleBotFillIfNeeded() {
    // Bots fill empty seats during an active game as long as at least 1 human is seated.
    if (!this.running) return;
    if (this.humanSeatCount() < 1) return;
    if (this.activeSeatCount() >= this.botFillTarget) {
      this.clearBotFillTimer();
      return;
    }
    if (this.botFillTimer) return;

    this.botFillDeadline = Date.now() + this.botFillDelayMs;
    this.botFillTimer = setTimeout(async () => {
      this.botFillTimer = null;
      this.botFillDeadline = null;
      if (!this.running || this.starting) return;
      if (this.humanSeatCount() < 1) return;
      if (this.activeSeatCount() >= this.botFillTarget) return;

      this.addBotsForMissingSeats();
      await this.broadcastState();
      await this.startIfReady({ refreshFromDb: false, allowBotFill: true });
    }, this.botFillDelayMs);
  }

  async syncMongoTableStatus() {
    try {
      const table = await Table.findById(this.tableId).select("seats capacity status gameType");
      if (!table || table.gameType !== "poker") return;
      const cap = normalizeCapacity(table.capacity);
      const next = derivePokerTableStatus({
        mongoSeatCount: table.seats.length,
        capacity: cap,
        running: this.running,
        round: this.round,
        frozen: this.frozen === true,
      });
      if (table.status !== next || table.capacity !== cap) {
        table.status = next;
        table.capacity = cap;
        await table.save();
      }
    } catch (e) {
      logger.warn("poker_sync_table_status_failed", {
        tableId: this.tableId,
        reason: e?.message || "unknown",
      });
    }
  }

  buildLobbyStateFields() {
    const humans = this.humanSeatCount();
    const active = this.activeSeatCount();
    const base = buildPokerLobbyFields({
      mongoSeatCount: humans,
      engineSeats: this.seats,
      capacity: this.capacity,
      running: this.running,
      round: this.round,
      frozen: this.frozen === true,
    });
    const canBotStart =
      !this.frozen &&
      this.round === "idle" &&
      humans >= 1 &&
      active >= POKER_MIN_PLAYERS;
    const playersNeeded =
      humans >= POKER_MIN_PLAYERS || canBotStart
        ? 0
        : Math.max(0, POKER_MIN_PLAYERS - humans);
    let tableStatus = base.tableStatus;
    if (this.running || (this.round && String(this.round) !== "idle")) {
      tableStatus = "playing";
    } else if (canBotStart || humans >= POKER_MIN_PLAYERS) {
      tableStatus = "ready";
    }
    if (this.frozen || this.tableStatusOverride === "frozen") {
      return {
        ...base,
        seatedCount: humans,
        humanSeatedCount: humans,
        activeSeatCount: active,
        totalSeatedCount: active,
        playersNeeded,
        tableStatus: "frozen",
        canStart: false,
      };
    }
    return {
      ...base,
      seatedCount: humans,
      humanSeatedCount: humans,
      activeSeatCount: active,
      totalSeatedCount: active,
      playersNeeded,
      tableStatus,
      canStart: humans >= POKER_MIN_PLAYERS || canBotStart,
      canStartWithBots: canBotStart,
    };
  }

  async bootstrapLobbyStart() {
    if (this.frozen && !this.running) {
      const probe = auditChipConservation(this, "unfreeze_probe");
      if (probe.ok) {
        this.frozen = false;
        this.tableStatusOverride = null;
        this.logSuspicious("unfreeze_false_positive", { context: "bootstrap" });
      }
    }
    if (this.frozen) return;
    if (this.running) return;
    if (this.round !== "idle") {
      this.healStaleRoundIfNotRunning();
    }
    if (this.round !== "idle") return;

    await this.refreshSeatsFromDb();

    if (this.humanSeatCount() >= 1 && this.activeSeatCount() < this.botFillTarget) {
      this.addBotsForMissingSeats();
    }

    const canBotStart =
      this.humanSeatCount() >= 1 && this.activeSeatCount() >= POKER_MIN_PLAYERS;

    if (this.eligibleHumanCount() >= POKER_MIN_PLAYERS || canBotStart) {
      this.clearWaitForPlayersTimer();
      await this.startIfReady({ refreshFromDb: false, allowBotFill: canBotStart });
      return;
    }

    if (
      !this.waitForPlayersTimer &&
      this.waitForPlayersDeadline != null &&
      this.waitForPlayersDeadline <= Date.now()
    ) {
      this.waitForPlayersDeadline = null;
      await this.onWaitForPlayersWindowEnd();
      return;
    }

    this.scheduleWaitForPlayers();
    await this.broadcastState();
  }

  async startIfReady({ refreshFromDb = true, allowBotFill = false } = {}) {
    if (this.frozen) return;
    if (this.running || this.starting) return;
    if (this.round !== "idle") {
      if (!this.running) this.healStaleRoundIfNotRunning();
      if (this.round !== "idle") {
        this.logSuspicious("start_if_ready_non_idle_round", { round: this.round });
        return;
      }
    }
    this.starting = true;
    try {
      if (refreshFromDb) {
        await this.refreshSeatsFromDb();
      }

      const humans = this.eligibleHumanCount();
      // Normal case: 2+ eligible humans.
      // Bot-fill case: at least 1 human and bots fill the remaining seats.
      const canStartWithBots =
        allowBotFill &&
        this.humanSeatCount() >= 1 &&
        this.activeSeatCount() >= POKER_MIN_PLAYERS;

      if (humans < POKER_MIN_PLAYERS && !canStartWithBots) {
        this.running = false;
        this.clearActionScheduling();
        this.clearBotFillTimer();
        this.scheduleWaitForPlayers();
        await this.syncMongoTableStatus();
        await this.broadcastState();
        return;
      }

      this.clearWaitForPlayersTimer();

      if (allowBotFill) {
        promoteWaitingToSeated(this.seats);
        for (const s of this.seats) {
          if (!isHumanSeat(s) || toSafeInt(s.chips, 0) <= 0) continue;
          if (s.playerState === PLAYER_STATE.SITTING_OUT && !s.disconnectedAt) {
            s.playerState = PLAYER_STATE.SEATED;
          }
        }
      }

      if (this.activeSeatCount() < POKER_MIN_PLAYERS) {
        this.running = false;
        this.clearActionScheduling();
        await this.syncMongoTableStatus();
        await this.broadcastState();
        return;
      }

      this.clearBotFillTimer();
      this.running = true;
      await this.syncMongoTableStatus();
      await this.startHand();
    } finally {
      this.starting = false;
    }
  }

  seatOrderFrom(dealerIndex) {
    const n = this.seats.length;
    const order = [];
    for (let i = 1; i <= n; i++) {
      order.push((dealerIndex + i) % n);
    }
    return order;
  }

  dealHoleCards(deck) {
    for (const s of this.seats) {
      if (canBeDealtIntoHand(s)) {
        s.inHand = true;
        s.folded = false;
        s.allIn = false;
        s.bet = 0;
        s.invested = 0;
        s.hole = draw(deck, 2);
        s.playerState = PLAYER_STATE.ACTIVE_HAND;
      } else {
        s.inHand = false;
        s.folded = true;
        s.allIn = false;
        s.bet = 0;
        s.invested = 0;
        s.hole = [];
        if (s.chips > 0 && s.playerState === PLAYER_STATE.WAITING) {
          /* stays WAITING until next hand promotion */
        }
      }
    }
  }

  postBlind(seat, amount) {
    const pay = Math.min(seat.chips, amount);
    seat.chips -= pay;
    seat.bet += pay;
    seat.invested += pay;
    this.pot += pay;
    if (seat.chips === 0) seat.allIn = true;
    return pay;
  }

  nextToActIndex(startIdx) {
    const n = this.seats.length;
    for (let k = 0; k < n; k++) {
      const i = (startIdx + k) % n;
      const s = this.seats[i];
      if (s.inHand && !s.folded && !s.allIn) {
        return i;
      }
    }
    return -1;
  }

  everyoneSettled() {
    // Everyone matched currentBet AND completed a voluntary action this street (BB option).
    return this.seats.every((s) => {
      if (!s.inHand || s.folded) return true;
      if (s.allIn) return true;
      if (s.bet !== this.currentBet) return false;
      return s.actedThisStreet === true;
    });
  }

  /**
   * Minimum extra raise for seat respecting poker rules + table minimum bet.
   */
  computeMinRaiseExtra(seatIndex) {
    const seat = this.seats[seatIndex];
    const tableMin = Math.max(1, toSafeInt(this.minimumBet, Math.floor(this.buyIn / 10) || this.bigBlind));
    const pokerMin = toSafeInt(this.lastRaiseAmount, this.bigBlind);
    const callAmount = seat
      ? Math.max(0, this.currentBet - seat.bet)
      : 0;

    let minExtra = Math.max(pokerMin, tableMin);
    if (callAmount === 0 && seat) {
      const minTotal = Math.max(tableMin, this.bigBlind);
      minExtra = Math.max(minExtra, minTotal - toSafeInt(seat.bet, 0));
    }
    return minExtra;
  }

  aliveCount() {
    return this.seats.filter((s) => s.inHand && !s.folded).length;
  }

  /**
   * Returns the turn-player-only action spec for the architecture contract.
   * minRaise/maxRaise are EXTRA amount above callAmount.
   */
  computeTurnActionSpec(seatIndex) {
    const seat = this.seats[seatIndex];
    if (!seat || !seat.inHand || seat.folded || seat.allIn) return null;

    const callAmount = Math.max(0, this.currentBet - seat.bet);
    const canCheck = callAmount === 0;
    const isAllInOnly = callAmount > 0 && seat.chips < callAmount;

    const minRaise = this.computeMinRaiseExtra(seatIndex);
    const maxRaise = Math.max(0, seat.chips - callAmount); // extra above call

    const allowed = ["fold"];
    if (canCheck) {
      allowed.push("check");
    } else {
      allowed.push("call");
    }

    // Remove raise if it can't satisfy the minimum extra raise.
    if (maxRaise < minRaise || maxRaise <= 0) {
      return {
        allowed,
        callAmount,
        minRaise,
        maxRaise,
        canCheck,
        isAllInOnly,
      };
    }

    allowed.push("raise");
    if (this.shortAllInNoReopen && seat.actedThisStreet) {
      const ri = allowed.indexOf("raise");
      if (ri >= 0) allowed.splice(ri, 1);
    }
    return {
      allowed,
      callAmount,
      minRaise,
      maxRaise,
      canCheck,
      isAllInOnly,
    };
  }

  async startHand() {
    this.clearActionScheduling();
    promoteWaitingToSeated(this.seats);

    // Reset
    this.community = [];
    this.pot = 0;
    if (!this.setRound("preflop")) return;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;
    this.currentHandId = `${this.tableId}-${Date.now()}-${this.handCounter + 1}`;
    this.handStartedAt = Date.now();
    this.currentHandActions = [];
    this.processedActionIds = new Set();
    this.shortAllInNoReopen = false;
    this.serverSeed = crypto.randomBytes(32).toString("hex");
    this.serverSeedHash = sha256Hex(this.serverSeed);
    const clientSeedMaterial = this.seats
      .map((s) => `${s.userId}:${s.clientSeed || "default"}`)
      .sort()
      .join("|");
    this.clientSeedDigest = sha256Hex(clientSeedMaterial);

    // Prepare deck
    const shuffleSeed = `${this.serverSeed}:${this.clientSeedDigest}:${this.currentHandId}`;
    const deck = shuffleDeterministic(newDeck(), shuffleSeed);

    for (const s of this.seats) {
      s.handStartChips = s.chips;
      s.lastAction = null;
      s.actedThisStreet = false;
    }

    // Deal hole cards
    this.dealHoleCards(deck);

    // Post blinds
    const order = this.seatOrderFrom(this.dealerIndex);
    const inHandIdxs = this.seats
      .map((s, i) => (s.inHand ? i : -1))
      .filter((i) => i >= 0);

    let sbIndex = order.find((i) => this.seats[i].inHand) ?? -1;
    let bbIndex = order.find((i) => i !== sbIndex && this.seats[i].inHand) ?? -1;

    // Heads-up rule: dealer posts SB and acts first preflop.
    if (inHandIdxs.length === 2) {
      const dealerInHand = this.seats[this.dealerIndex]?.inHand === true;
      const dealerSeat = dealerInHand ? this.dealerIndex : inHandIdxs[0];
      const otherSeat = inHandIdxs.find((i) => i !== dealerSeat) ?? -1;
      if (otherSeat >= 0) {
        sbIndex = dealerSeat;
        bbIndex = otherSeat;
      }
    }

    if (sbIndex === -1 || bbIndex === -1) {
      // Not enough players — reset to lobby instead of leaving a stale preflop.
      this.healStaleRoundIfNotRunning();
      this.running = false;
      this.clearActionScheduling();
      if (this.humanSeatCount() >= 1 && this.activeSeatCount() < this.botFillTarget) {
        this.addBotsForMissingSeats();
      }
      this.scheduleWaitForPlayers();
      await this.broadcastState();
      return;
    }
    this.sbSeatIndex = sbIndex;
    this.bbSeatIndex = bbIndex;
    const sbPaid = this.postBlind(this.seats[sbIndex], this.smallBlind);
    const bbPaid = this.postBlind(this.seats[bbIndex], this.bigBlind);
    this.currentBet = Math.max(sbPaid, bbPaid);
    this.lastRaiseAmount = Math.max(this.bigBlind, this.currentBet);
    this.appendHandAction({
      type: "blind",
      seatIndex: sbIndex,
      playerId: this.seats[sbIndex]?.userId,
      amount: sbPaid,
      blind: "SB",
    });
    this.recordSeatAction(sbIndex, "blind", sbPaid);
    this.appendHandAction({
      type: "blind",
      seatIndex: bbIndex,
      playerId: this.seats[bbIndex]?.userId,
      amount: bbPaid,
      blind: "BB",
    });
    this.recordSeatAction(bbIndex, "blind", bbPaid);

    // First to act preflop: in heads-up it's SB(dealer), otherwise next after BB.
    const start = inHandIdxs.length === 2
      ? sbIndex
      : (order.find((i) => i !== sbIndex && i !== bbIndex && this.seats[i].inHand) ?? bbIndex);
    this.currentIndex = this.nextToActIndex(start);

    // Burn+flop/turn/river deferred until rounds advance
    this.deck = deck;

    // Jackpot contribution per hand (Golden Island) — skipped when fee is 0.
    const jackpotDeducted = await this.applyJackpotContribution();

    this.handStartTotal = this.seats.reduce(
      (sum, s) => sum + toSafeInt(s.handStartChips, toSafeInt(s.chips, 0)),
      0
    ) - toSafeInt(jackpotDeducted, 0);
    const ok = await this.auditChipConservation("post_blinds");
    if (!ok) return;

    await this.broadcastState();
    await sleep(POKER_TIMINGS.PREFLOP_DEAL_MS);
    this.scheduleCurrentTurn();
  }

  scheduleCurrentTurn() {
    this.clearActionScheduling();
    if (!this.running) return;

    const seat = this.seats[this.currentIndex];
    if (!seat || !seat.inHand || seat.folded || seat.allIn) {
      this.actionDeadline = null;
      setTimeout(() => this.advance(), 0);
      return;
    }

    if (seat.isBot) {
      this.actionDeadline = null;
      const thinkMs = 900 + secureRandomInt(1500);
      this.botThinkTimer = setTimeout(() => {
        this.playBotTurn(this.currentIndex);
      }, thinkMs);
      return;
    }

    this.actionDeadline = Date.now() + this.turnSeconds * 1000;
    const expectedIndex = this.currentIndex;
    this.turnTimer = setTimeout(() => {
      this.handleTimeout(expectedIndex);
    }, this.turnSeconds * 1000 + 100);
  }

  async handleTimeout(expectedIndex) {
    const lockAcquired = await this.acquireActionLock();
    if (!lockAcquired) {
      setTimeout(() => {
        void this.handleTimeout(expectedIndex);
      }, 300);
      return;
    }

    try {
      // Guard: if turn already advanced to a different player, skip
      if (expectedIndex !== undefined && this.currentIndex !== expectedIndex) return;
      const s = this.seats[this.currentIndex];
      if (!s || !s.inHand || s.folded || s.allIn || s.chips <= 0) {
        await this.advance();
        return;
      }

      const callAmount = Math.max(0, this.currentBet - s.bet);
      // Architecture timeout rule
      if (callAmount === 0) {
        // Acts as "call/check"
        this.applyCall(this.currentIndex);
        this.recordSeatAction(this.currentIndex, "check", 0);
        this.appendHandAction({
          type: "timeout_call",
          seatIndex: this.currentIndex,
          playerId: this.seats[this.currentIndex]?.userId,
          amount: 0,
        });
      } else {
        this.applyFold(this.currentIndex);
        this.recordSeatAction(this.currentIndex, "fold");
        this.appendHandAction({
          type: "timeout_fold",
          seatIndex: this.currentIndex,
          playerId: this.seats[this.currentIndex]?.userId,
        });
      }
      this.markVoluntaryAction(this.currentIndex);
      await this.pacedAdvanceAfterAction();
    } finally {
      await this.releaseActionLock();
    }
  }

  botRaiseSize(i) {
    const seat = this.seats[i];
    if (!seat) return 0;
    const need = Math.max(0, this.currentBet - seat.bet);
    const minExtra = this.currentBet > 0 ? this.minRaise : this.bigBlind;
    const maxExtra = Math.max(0, seat.chips - need);
    if (maxExtra < minExtra) return 0;
    const cap = Math.max(minExtra, Math.min(maxExtra, this.bigBlind * 6));
    if (cap <= minExtra) return minExtra;
    return minExtra + secureRandomInt(cap - minExtra + 1);
  }

  async playBotTurn(seatIndex) {
    if (!this.running) return;
    if (seatIndex !== this.currentIndex) return;
    const seat = this.seats[seatIndex];
    if (!seat || !seat.isBot || !seat.inHand || seat.folded || seat.allIn) return;

    const need = Math.max(0, this.currentBet - seat.bet);
    const stack = seat.chips;
    const canRaise = this.botRaiseSize(seatIndex) > 0;
    const roll = secureRandomInt(1_000_000_000) / 1_000_000_000;

    if (need === 0) {
      if (canRaise && stack > this.bigBlind * 2 && roll < 0.22) {
        const raise = this.botRaiseSize(seatIndex);
        if (raise > 0) {
          this.applyBetOrRaise(seatIndex, raise);
          this.recordSeatAction(seatIndex, "raise", raise);
        }
      } else {
        const beforeChips = this.seats[seatIndex].chips;
        this.applyCall(seatIndex);
        const paid = Math.max(0, beforeChips - this.seats[seatIndex].chips);
        this.recordSeatAction(seatIndex, "check", paid);
      }
    } else if (need >= stack) {
      if (roll < 0.72) {
        const beforeChips = this.seats[seatIndex].chips;
        this.applyCall(seatIndex);
        const paid = Math.max(0, beforeChips - this.seats[seatIndex].chips);
        this.recordSeatAction(seatIndex, "call", paid);
      } else {
        this.applyFold(seatIndex);
        this.recordSeatAction(seatIndex, "fold");
      }
    } else if (need <= this.bigBlind) {
      if (canRaise && roll < 0.16) {
        const raise = this.botRaiseSize(seatIndex);
        if (raise > 0) {
          this.applyBetOrRaise(seatIndex, raise);
          this.recordSeatAction(seatIndex, "raise", raise);
        }
      } else if (roll < 0.82) {
        const beforeChips = this.seats[seatIndex].chips;
        this.applyCall(seatIndex);
        const paid = Math.max(0, beforeChips - this.seats[seatIndex].chips);
        this.recordSeatAction(seatIndex, "call", paid);
      } else {
        this.applyFold(seatIndex);
        this.recordSeatAction(seatIndex, "fold");
      }
    } else {
      if (canRaise && roll < 0.1) {
        const raise = this.botRaiseSize(seatIndex);
        if (raise > 0) {
          this.applyBetOrRaise(seatIndex, raise);
          this.recordSeatAction(seatIndex, "raise", raise);
        }
      } else if (roll < 0.63) {
        const beforeChips = this.seats[seatIndex].chips;
        this.applyCall(seatIndex);
        const paid = Math.max(0, beforeChips - this.seats[seatIndex].chips);
        this.recordSeatAction(seatIndex, "call", paid);
      } else {
        this.applyFold(seatIndex);
        this.recordSeatAction(seatIndex, "fold");
      }
    }

    this.markVoluntaryAction(seatIndex);
    await this.pacedAdvanceAfterAction();
  }

  applyFold(i) {
    this.seats[i].folded = true;
  }

  applyCall(i) {
    const need = Math.max(0, this.currentBet - this.seats[i].bet);
    const pay = Math.min(need, this.seats[i].chips);
    this.seats[i].chips -= pay;
    this.seats[i].bet += pay;
    this.seats[i].invested += pay;
    this.pot += pay;
    if (this.seats[i].chips === 0) this.seats[i].allIn = true;
  }

  applyBetOrRaise(i, amount) {
    const need = Math.max(0, this.currentBet - this.seats[i].bet);
    const toPut = need + amount; // amount is raise size (for bet, currentBet==0, need is 0)
    const pay = Math.min(toPut, this.seats[i].chips);
    const prevCurrentBet = this.currentBet;
    const prevLastRaise = this.lastRaiseAmount;

    this.seats[i].chips -= pay;
    this.seats[i].bet += pay;
    this.seats[i].invested += pay;
    this.pot += pay;

    const contributed = this.seats[i].bet;
    if (contributed > this.currentBet) {
      const diff = contributed - this.currentBet;
      this.currentBet = contributed;

      // Real-money rule: short all-in raise does NOT reopen action and does
      // NOT change lastRaiseAmount/minRaise. Only full raises do.
      const wasAllIn = this.seats[i].chips === 0;
      const isFullRaise = diff >= prevLastRaise;
      if (!wasAllIn || isFullRaise) {
        this.lastRaiseAmount = diff;
        this.minRaise = this.lastRaiseAmount;
        this.shortAllInNoReopen = false;
      } else {
        this.lastRaiseAmount = prevLastRaise;
        this.minRaise = prevLastRaise;
        this.shortAllInNoReopen = true;
      }

      this.appendHandAction({
        type: "bet_level_update",
        seatIndex: i,
        playerId: this.seats[i]?.userId,
        previousBet: prevCurrentBet,
        newBet: this.currentBet,
        raiseDelta: diff,
        prevLastRaise,
        updatedLastRaise: this.lastRaiseAmount,
        fullRaise: !wasAllIn || isFullRaise,
        shortAllIn: wasAllIn && !isFullRaise,
      });
    }
    if (this.seats[i].chips === 0) this.seats[i].allIn = true;
  }

  buildSidePots() {
    const invested = this.seats
      .map((s, i) => ({
        i,
        amount: Number(s.invested || 0),
        eligible: s.inHand && !s.folded,
      }))
      .filter((x) => x.amount > 0);

    if (invested.length === 0) return [];

    const thresholds = [...new Set(invested.map((x) => x.amount))].sort((a, b) => a - b);
    const sidePots = [];
    let prev = 0;

    for (const t of thresholds) {
      const contributors = invested.filter((x) => x.amount >= t).map((x) => x.i);
      const eligible = invested
        .filter((x) => x.amount >= t && x.eligible)
        .map((x) => x.i);
      const amount = (t - prev) * contributors.length;
      if (amount > 0) {
        sidePots.push({ amount, contributors, eligible });
      }
      prev = t;
    }

    return sidePots;
  }

  resolveSidePotPayouts(rankByIndex) {
    const payouts = new Map();
    const seatOrder = this.seatOrderFrom(this.dealerIndex);
    const sidePots = this.buildSidePots();

    for (const pot of sidePots) {
      if (!pot.eligible || pot.eligible.length === 0 || pot.amount <= 0) continue;

      let winners = [pot.eligible[0]];
      for (const idx of pot.eligible.slice(1)) {
        const cmp = this.compareRank(rankByIndex.get(idx), rankByIndex.get(winners[0]));
        if (cmp > 0) {
          winners = [idx];
        } else if (cmp === 0) {
          winners.push(idx);
        }
      }

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const orderedWinners = seatOrder.filter((i) => winners.includes(i));

      for (const idx of orderedWinners) {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        payouts.set(idx, (payouts.get(idx) || 0) + share + extra);
      }
    }

    return payouts;
  }

  resolveSidePotPayoutsWithDistribution(rankByIndex) {
    const payouts = new Map();
    const seatOrder = this.seatOrderFrom(this.dealerIndex);
    const sidePots = this.buildSidePots();

    let potId = 0;
    const potDistribution = [];

    for (const pot of sidePots) {
      if (!pot.eligible || pot.eligible.length === 0 || pot.amount <= 0) continue;

      potId += 1;

      let winners = [pot.eligible[0]];
      for (const idx of pot.eligible.slice(1)) {
        const cmp = this.compareRank(rankByIndex.get(idx), rankByIndex.get(winners[0]));
        if (cmp > 0) {
          winners = [idx];
        } else if (cmp === 0) {
          winners.push(idx);
        }
      }

      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      const orderedWinners = seatOrder.filter((i) => winners.includes(i));

      const winnersDistribution = [];
      for (const idx of orderedWinners) {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;

        const amountWon = share + extra;
        payouts.set(idx, (payouts.get(idx) || 0) + amountWon);
        winnersDistribution.push({ seatIndex: idx, amountWon });
      }

      potDistribution.push({
        potId,
        amount: pot.amount, // gross (before rake)
        eligibleSeatIndices: pot.eligible,
        winners: winnersDistribution,
      });
    }

    return { payouts, potDistribution };
  }

  applyRakeToPayouts(payouts, rake) {
    const cutsBySeat = new Map();
    if (!rake || rake <= 0) return cutsBySeat;
    let remaining = rake;
    const ordered = [...payouts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [idx, amount] of ordered) {
      if (remaining <= 0) break;
      const cut = Math.min(amount, remaining);
      payouts.set(idx, amount - cut);
      if (cut > 0) cutsBySeat.set(idx, cut);
      remaining -= cut;
    }
    return cutsBySeat;
  }

  burn(n = 1) {
    draw(this.deck, n);
  }

  dealCommunity(n) {
    this.community.push(...draw(this.deck, n));
  }

  endBettingRound() {
    for (const s of this.seats) {
      s.bet = 0;
      s.actedThisStreet = false;
    }
    this.currentBet = 0;
    this.lastRaiseAmount = this.bigBlind;
    this.minRaise = this.lastRaiseAmount;
    this.shortAllInNoReopen = false;
  }

  async pacedAdvanceAfterAction() {
    await sleep(POKER_TIMINGS.ACTION_REVEAL_MS);
    await this.advance();
  }

  async advance() {
    if (this.frozen) return;
    const okPre = await this.auditChipConservation("advance_pre");
    if (!okPre) return;
    // If one alive -> award
    if (this.aliveCount() <= 1) {
      await this.finishHandByFold();
      return;
    }

    // If betting round settled, advance street or showdown
    if (this.everyoneSettled()) {
      const okStreet = await this.auditChipConservation(`street_end_${this.round}`);
      if (!okStreet) return;
      let streetDelay = 0;
      if (this.round === "preflop") {
        this.endBettingRound();
        this.burn(1);
        this.dealCommunity(3); // flop
        this.setRound("flop");
        this.appendHandAction({ type: "street", street: "flop" });
        streetDelay = POKER_TIMINGS.FLOP_MS;
      } else if (this.round === "flop") {
        this.endBettingRound();
        this.burn(1);
        this.dealCommunity(1); // turn
        this.setRound("turn");
        this.appendHandAction({ type: "street", street: "turn" });
        streetDelay = POKER_TIMINGS.TURN_STREET_MS;
      } else if (this.round === "turn") {
        this.endBettingRound();
        this.burn(1);
        this.dealCommunity(1); // river
        this.setRound("river");
        this.appendHandAction({ type: "street", street: "river" });
        streetDelay = POKER_TIMINGS.RIVER_MS;
      } else if (this.round === "river") {
        await this.showdown();
        return;
      }
      const order = this.seatOrderFrom(this.dealerIndex);
      const start = order[0];
      this.currentIndex = this.nextToActIndex(start);
      await this.broadcastState();
      if (streetDelay > 0) await sleep(streetDelay);
      const okPost = await this.auditChipConservation(`street_start_${this.round}`);
      if (!okPost) return;
      this.scheduleCurrentTurn();
      return;
    }

    // Otherwise move to next player
    this.currentIndex = this.nextToActIndex(this.currentIndex + 1);
    await this.broadcastState();
    this.scheduleCurrentTurn();
  }

  async finishHandByFold() {
    // Award whole pot to the only alive player
    const winnerIdx = this.seats.findIndex((s) => s.inHand && !s.folded);
    const payouts = new Map();
    if (winnerIdx >= 0 && this.pot > 0) {
      payouts.set(winnerIdx, this.pot);
    }
    await this.persistAndPrepareNext(
      [],
      payouts,
      winnerIdx >= 0 ? [winnerIdx] : [],
      { reason: "fold" }
    );
  }

  /**
   * Last raise on river (then turn, flop, preflop). Used for TV-style show order.
   */
  findLastAggressiveSeatIndexBeforeShowdown() {
    const streets = ["river", "turn", "flop", "preflop"];
    for (const r of streets) {
      for (let i = this.currentHandActions.length - 1; i >= 0; i--) {
        const a = this.currentHandActions[i];
        if (!a || typeof a !== "object") continue;
        const t = String(a.type || "");
        if (t === "street") continue;
        if (String(a.round || "") !== r) continue;
        if (t === "raise") {
          const si = toSafeInt(a.seatIndex, -1);
          if (si >= 0 && si < this.seats.length) return si;
        }
      }
    }
    return -1;
  }

  /**
   * Losers first: seat order from last aggressor (if a contender), else dealer order.
   * Winners last: weaker hands first, strongest last (dramatic nuts reveal).
   */
  buildShowdownRevealOrder(contenderSeatIndices, winnerSeatIndices, options = {}) {
    const win = new Set(winnerSeatIndices || []);
    const contenders = new Set(contenderSeatIndices || []);
    const order = this.seatOrderFrom(this.dealerIndex).filter((i) => contenders.has(i));

    const loserOrderBase = order.filter((i) => !win.has(i));
    const lastAgg = toSafeInt(options.lastAggressorSeat, -1);
    let losers = loserOrderBase;
    if (lastAgg >= 0 && loserOrderBase.includes(lastAgg)) {
      const k = loserOrderBase.indexOf(lastAgg);
      losers = [...loserOrderBase.slice(k), ...loserOrderBase.slice(0, k)];
    }

    const winners = order.filter((i) => win.has(i));
    const rankByIndex = options.rankByIndex;
    const byTable = (a, b) => order.indexOf(a) - order.indexOf(b);
    let orderedWinners = [...winners];
    if (rankByIndex instanceof Map) {
      orderedWinners.sort((a, b) => {
        const cmp = this.compareRank(rankByIndex.get(a), rankByIndex.get(b));
        if (cmp !== 0) return cmp;
        return byTable(a, b);
      });
    } else {
      orderedWinners.sort(byTable);
    }

    return [...losers, ...orderedWinners];
  }

  async showdown() {
    if (!this.setRound("showdown")) return;
    this.appendHandAction({ type: "street", street: "showdown" });
    this.showdownRevealedSeats = new Set();

    const contenders = this.seats
      .map((s, i) => ({ i, s }))
      .filter(({ s }) => s.inHand && !s.folded);

    const rankByIndex = new Map();
    const showdownRanks = new Map();
    let bestIdxs = [];
    let bestRank = null;
    for (const { i, s } of contenders) {
      const rank = bestOf7([...s.hole, ...this.community]);
      rankByIndex.set(i, rank);
      showdownRanks.set(i, {
        cat: rank.cat,
        tiebreak: rank.tiebreak,
        name: handCategoryName(rank),
      });
      if (!bestRank) {
        bestRank = rank;
        bestIdxs = [i];
      } else {
        const cmp = this.compareRank(rank, bestRank);
        if (cmp > 0) {
          bestRank = rank;
          bestIdxs = [i];
        } else if (cmp === 0) {
          bestIdxs.push(i);
        }
      }
    }

    try {
      await this.applyJackpotPayout(bestIdxs);
    } catch (e) {}

    const { payouts, potDistribution } = this.resolveSidePotPayoutsWithDistribution(rankByIndex);
    const handCategory =
      bestIdxs.length > 0 ? showdownRanks.get(bestIdxs[0])?.name || null : null;

    const pauseMs = POKER_TIMINGS.SHOWDOWN_MS;
    const gapMs = Math.max(400, Math.floor(POKER_TIMINGS.SHOWDOWN_MS / 8));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const room = `tg:${this.tableId}`;

    const lastAggSeat = this.findLastAggressiveSeatIndexBeforeShowdown();
    const revealOrder = this.buildShowdownRevealOrder(
      contenders.map((c) => c.i),
      bestIdxs,
      { lastAggressorSeat: lastAggSeat, rankByIndex }
    );

    const winnerUserIds = bestIdxs.map((i) => String(this.seats[i]?.userId || ""));
    this.nsp.to(room).emit("showdown_start", {
      players: contenders.map(({ i, s }) => ({ userId: String(s.userId), seatIndex: i })),
      winnerUserIds,
      winnerSeatIndices: bestIdxs,
      pauseMs,
      revealGapMs: gapMs,
      lastAggressorSeatIndex: lastAggSeat >= 0 ? lastAggSeat : null,
      revealStrategy: "last_aggressor_then_strength",
      stateRevision: toSafeInt(this.stateRevision, 0),
    });
    await this.broadcastState(false);

    await sleep(pauseMs);

    // Only seats with two hole cards participate in reveal steps; using the raw
    // contender order for `step`/`total`/`dramatic` breaks clients when any seat
    // is skipped (wrong counts, missing dramatic reveal).
    const revealSteps = [];
    for (const seatIndex of revealOrder) {
      const s = this.seats[seatIndex];
      if (!s || !Array.isArray(s.hole) || s.hole.length < 2) continue;
      revealSteps.push({ seatIndex, s });
    }
    const total = revealSteps.length;

    // When the showdown pause timer ends, reveal everyone's cards together.
    for (let step = 0; step < total; step++) {
      const { seatIndex, s } = revealSteps[step];
      this.showdownRevealedSeats.add(seatIndex);
      const dramatic = step === total - 1;
      const cat = showdownRanks.get(seatIndex)?.name || null;
      this.nsp.to(room).emit("reveal_card", {
        userId: String(s.userId),
        seatIndex,
        cards: [String(s.hole[0] || ""), String(s.hole[1] || "")],
        isWinner: bestIdxs.includes(seatIndex),
        dramatic,
        step: step + 1,
        total,
        handCategory: cat,
        batch: true,
      });
    }
    if (total > 0) {
      await this.broadcastState(false);
      await sleep(POKER_TIMINGS.SHOWDOWN_CARD_HOLD_MS);
    }

    await this.broadcastState(true);

    const potBeforeSettlement = toSafeInt(this.pot, 0);
    const contributions = [];
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      const uid = String(s?.userId || "");
      const amt = toSafeInt(s?.invested, 0);
      if (uid && amt > 0) contributions.push({ userId: uid, amount: amt });
    }
    const closingHandId = this.currentHandId;

    const potsPayload = potDistribution.map((p) => ({
      amount: toSafeInt(p.amount, 0),
      eligibleUserIds: (Array.isArray(p.eligibleSeatIndices) ? p.eligibleSeatIndices : [])
        .map((si) => String(this.seats[toSafeInt(si, -1)]?.userId || ""))
        .filter(Boolean),
      winnerUserIds: (Array.isArray(p.winners) ? p.winners : [])
        .map((w) => String(this.seats[toSafeInt(w.seatIndex, -1)]?.userId || ""))
        .filter(Boolean),
    }));

    let winnerBadge = "WINNER";
    if (bestIdxs.length > 1) {
      winnerBadge = "SPLIT_POT";
    } else if (bestIdxs.length === 1) {
      const ws = this.seats[bestIdxs[0]];
      if (ws && ws.allIn) winnerBadge = "ALL_IN_WIN";
    }

    this.showdownEndSeq = toSafeInt(this.showdownEndSeq, 0) + 1;

    await this.persistAndPrepareNext(this.community, payouts, bestIdxs, {
      reason: "showdown",
      showdownRanks,
      potDistribution,
      handCategory,
    }, { manageLifecycle: false });

    this.showdownRevealedSeats = new Set();
    this.nsp.to(room).emit("showdown_end", {
      handId: closingHandId,
      showdownSeq: this.showdownEndSeq,
      winnerUserIds,
      winners: winnerUserIds.slice(),
      pot: potBeforeSettlement,
      contributions,
      pots: potsPayload,
      winnerBadge,
      stateRevision: toSafeInt(this.stateRevision, 0),
    });

    this.setRound("idle");
    await this.broadcastState();
    this.currentHandId = null;
    this.currentHandActions = [];
    this.processedActionIds = new Set();

    // Winner banner is now visible; wait NEXT_HAND_DELAY_MS before dealing again
    // so the win display and the next hand never overlap.
    this.scheduleNextHand();
  }

  async applyJackpotContribution() {
    try {
      const enabled = String(process.env.JACKPOT_ENABLED || "").toLowerCase() === "true";
      if (!enabled) return 0;

      const j = await Jackpot.getSingleton();
      const envFee = process.env.JACKPOT_FEE_PER_HAND;
      const fee = envFee != null && String(envFee).trim() !== ""
        ? Math.max(0, Number(envFee))
        : Math.max(0, Number(j.contributionPerHand || 0));
      if (fee <= 0) return 0;
      let total = 0;
      for (const s of this.seats) {
        if (!s.isBot && s.inHand && s.chips > 0) {
          const d = Math.min(s.chips, fee);
          s.chips -= d;
          total += d;
          if (s.chips === 0) s.allIn = true;
        }
      }
      if (total > 0) {
        j.pot += total;
        await j.save();
      }
      return total;
    } catch (e) {
      return 0;
    }
  }

  /** Zero pot/street bets after hand settlement — prevents double-count in idle UI. */
  resetHandBettingState() {
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastRaiseAmount = this.bigBlind;
    this.shortAllInNoReopen = false;
    for (const s of this.seats) {
      s.bet = 0;
      s.invested = 0;
      s.actedThisStreet = false;
    }
  }

  async persistAndPrepareNext(community, payoutBySeat, winnerIdxs, meta = {}, opts = {}) {
    const manageLifecycle = opts.manageLifecycle !== false;
    // Rake simple percentage
    const rakePct = Math.max(
      0,
      Math.min(0.2, parseFloat(process.env.RAKE_PERCENT || "0.05"))
    );
    const rake = Math.floor(this.pot * rakePct);
    const payouts = payoutBySeat instanceof Map ? new Map(payoutBySeat) : new Map();
    const cutsBySeat = this.applyRakeToPayouts(payouts, rake);

    const showdownRanks = meta.showdownRanks instanceof Map ? meta.showdownRanks : null;
    const handCategory =
      meta.handCategory ??
      (showdownRanks && winnerIdxs && winnerIdxs.length > 0 ? showdownRanks.get(winnerIdxs[0])?.name || null : null);

    const potDistributionGross = Array.isArray(meta.potDistribution) ? meta.potDistribution : null;
    const potDistributionWork = potDistributionGross
      ? potDistributionGross.map((p) => ({
        potId: p.potId,
        eligibleSeatIndices: Array.isArray(p.eligibleSeatIndices) ? [...p.eligibleSeatIndices] : [],
        winners: Array.isArray(p.winners) ? p.winners.map((w) => ({
          seatIndex: w.seatIndex,
          amountWon: Number(w.amountWon || 0),
        })) : [],
      }))
      : null;

    // Apply rake cuts to potDistribution winners as well (seat-level cuts).
    if (potDistributionWork && cutsBySeat && cutsBySeat.size > 0) {
      const remainingCuts = new Map(cutsBySeat);
      for (const pot of potDistributionWork) {
        for (const winner of pot.winners) {
          const seatIdx = winner.seatIndex;
          const cutLeft = remainingCuts.get(seatIdx) || 0;
          if (cutLeft <= 0) continue;
          const reduction = Math.min(cutLeft, winner.amountWon);
          winner.amountWon -= reduction;
          const newLeft = cutLeft - reduction;
          if (newLeft <= 0) remainingCuts.delete(seatIdx);
          else remainingCuts.set(seatIdx, newLeft);
        }
      }
    }
    const winners = [];
    for (const [idx, share] of payouts.entries()) {
      if (!Number.isFinite(share) || share <= 0) continue;
      this.seats[idx].chips += share;
      if (!this.seats[idx].isBot && !isBotUserId(this.seats[idx].userId)) {
        winners.push({ user: this.seats[idx].userId, share });
      }
    }

    this.resetHandBettingState();

    const winnerSummaries = [];
    for (const [idx, share] of payouts.entries()) {
      if (!Number.isFinite(share) || share <= 0) continue;
      const rankInfo = showdownRanks ? showdownRanks.get(idx) : null;
      const playerId = this.seats[idx]?.userId;
      winnerSummaries.push({
        userId: this.seats[idx].userId,
        playerId: playerId,
        name: this.seats[idx].name,
        isBot: !!this.seats[idx].isBot,
        share,
        amountWon: share,
        handCategory: rankInfo?.name || null,
      });
    }

    const seatSummaries = this.seats.map((s, idx) => {
      const chipsBefore = toSafeInt(s.handStartChips, s.chips);
      const chipsAfter = toSafeInt(s.chips, 0);
      const rankInfo = showdownRanks ? showdownRanks.get(idx) : null;
      const atShowdown = meta.reason === "showdown" && s.inHand && !s.folded;
      return {
        seatIndex: idx,
        userId: s.userId,
        name: s.name,
        isBot: !!s.isBot,
        chipsBefore,
        chipsAfter,
        net: chipsAfter - chipsBefore,
        folded: !!s.folded,
        allIn: !!s.allIn,
        won: (payouts.get(idx) || 0) > 0,
        handCategory: rankInfo?.name || null,
        ...(atShowdown && Array.isArray(s.hole) && s.hole.length
          ? { hole: [...s.hole] }
          : {}),
      };
    });

    const potDistributionFinal = potDistributionWork
      ? potDistributionWork
        .map((p) => {
          const eligiblePlayers = p.eligibleSeatIndices
            .map((seatIdx) => this.seats[seatIdx]?.userId)
            .filter(Boolean);

          const winners = p.winners
            .filter((w) => w.amountWon > 0)
            .map((w) => ({
              playerId: this.seats[w.seatIndex]?.userId,
              amountWon: w.amountWon,
            }))
            .filter((w) => w.playerId);

          const amount = winners.reduce((sum, w) => sum + (w.amountWon || 0), 0);

          return {
            potId: p.potId,
            amount,
            eligiblePlayers,
            winners,
          };
        })
        .filter((p) => p.amount > 0)
      : null;

    this.handCounter += 1;
    this.lastHand = {
      id: this.handCounter,
      handId: this.currentHandId,
      reason: meta.reason || (showdownRanks ? "showdown" : "fold"),
      endedAt: Date.now(),
      pot: this.pot,
      rake,
      community: [...community],
      winners: winnerSummaries,
      seats: seatSummaries,
      handCategory: handCategory || null,
      potDistribution: potDistributionFinal,
      actions: [...this.currentHandActions],
      provablyFair: {
        serverSeed: this.serverSeed,
        serverSeedHash: this.serverSeedHash,
        clientSeedDigest: this.clientSeedDigest,
        handId: this.currentHandId,
      },
    };

    // Atomic financial + history settlement
    const auditLog = buildHandAuditLog(this.currentHandActions, this.seats, community);
    let settledHandHistoryId = null;
    try {
      await withMongoTransaction(async (session) => {
        const createOpts = session ? { session } : {};
        const [handDoc] = await HandHistory.create(
          [
            {
              handId: this.currentHandId,
              table: this.tableId,
              gameType: "poker",
              dealerSeatIndex: this.dealerIndex,
              smallBlind: this.smallBlind,
              bigBlind: this.bigBlind,
              startedAt: this.handStartedAt ? new Date(this.handStartedAt) : new Date(),
              players: this.seats
                .filter((s) => !s.isBot)
                .map((s) => ({
                  user: s.userId,
                  seatIndex: this.seats.findIndex((x) => String(x.userId) === String(s.userId)),
                  chipsBefore: toSafeInt(s.handStartChips, s.chips),
                  chipsAfter: s.chips,
                })),
              actions: this.currentHandActions.map((a) => ({
                ts: a.ts,
                round: a.round,
                type: a.type,
                playerId: a.playerId,
                seatIndex: a.seatIndex,
                amount: toSafeInt(a.amount, 0),
                callAmount: toSafeInt(a.callAmount, 0),
              })),
              auditLog,
              community,
              pot: this.pot,
              rake,
              winners,
              potDistribution: potDistributionFinal || [],
              handCategory: handCategory || null,
              seats: this.seats.map((s) => ({
                user: s.isBot ? undefined : s.userId,
                chipsBefore: toSafeInt(s.handStartChips, s.chips),
                chipsAfter: s.chips,
                hole: s.hole,
              })),
              endedAt: new Date(),
              provablyFair: {
                serverSeed: this.serverSeed,
                serverSeedHash: this.serverSeedHash,
                clientSeedDigest: this.clientSeedDigest,
                handId: this.currentHandId,
              },
            },
          ],
          createOpts
        );
        settledHandHistoryId = handDoc?._id || null;

        // Persist seat chips and write ledger entries for each human player delta.
        const tableQuery = Table.findById(this.tableId);
        const table = session ? await tableQuery.session(session) : await tableQuery;
        if (table) {
          let humanNetDelta = 0;
          for (const s of this.seats) {
            if (s.isBot || isBotUserId(s.userId)) continue;
            const chipsBefore = toSafeInt(s.handStartChips, s.chips);
            const chipsAfter = toSafeInt(s.chips, 0);
            humanNetDelta += chipsAfter - chipsBefore;
          }
          if (humanNetDelta !== 0) {
            await applyHouseSettlementDelta({
              session,
              delta: -humanNetDelta,
              tableId: this.tableId,
              handId: this.currentHandId,
              meta: {
                reason: "poker_hand_settlement_counterparty",
                round: this.round,
              },
            });
          }

          for (const tSeat of table.seats) {
            const s = this.seats.find((x) => String(x.userId) === String(tSeat.user));
            if (!s) continue;

            const seatIdx = this.seats.findIndex(
              (x) => String(x.userId) === String(tSeat.user)
            );
            const chipsBefore = toSafeInt(s.handStartChips, s.chips);
            const chipsAfter = toSafeInt(s.chips, 0);
            const delta = chipsAfter - chipsBefore;
            const rakeCut = toSafeInt(cutsBySeat.get(seatIdx) || 0, 0);

            // Wallet/ledger uses lockedBalance for in-game chips.
            await applyLockedDelta({
              session,
              userId: s.userId,
              delta,
              rakeAmount: rakeCut,
              tableId: this.tableId,
              handId: this.currentHandId,
              meta: {
                reason: "hand_settlement",
                round: this.round,
                chipsBefore,
                chipsAfter,
              },
            });

            tSeat.chips = chipsAfter;
          }
          await table.save(session ? { session } : undefined);
        }
      });

      try {
        const humanIds = this.seats
          .filter((s) => !s.isBot && !isBotUserId(s.userId))
          .map((s) => s.userId);
        const wonIds = winners.map((w) => w.user).filter(Boolean);
        const wonSet = new Set(wonIds.map((id) => String(id)));

        if (humanIds.length) {
          const ops = humanIds.map((uid) => {
            const isWon = wonSet.has(String(uid));
            if (isWon) {
              return {
                updateOne: {
                  filter: { _id: uid },
                  update: { $inc: { pokerHandsPlayed: 1, pokerHandsWon: 1, pokerWinStreak: 1 } },
                },
              };
            }
            return {
              updateOne: {
                filter: { _id: uid },
                update: { $inc: { pokerHandsPlayed: 1 }, $set: { pokerWinStreak: 0 } },
              },
            };
          });
          await User.bulkWrite(ops);
        }

        const tid = String(this.tableId);
        const hid = this.currentHandId;
        for (const uid of humanIds) {
          trackEventServerFireAndForget("hand_played", uid, { tableId: tid, handId: hid }, "server");
        }

        try {
          const { publish } = require("../domain/events/domainEventBus");
          const Events = require("../domain/events/eventTypes");
          const { XP_RATES } = require("../modules/playerProgress/config/playerProgressConfig");
          for (const uid of humanIds) {
            publish(Events.PLAYER_COMPLETED_GAME, {
              userId: String(uid),
              gameType: "poker",
              handsPlayed: 1,
              xp: XP_RATES.pokerHand,
            });
          }
        } catch (_) {}
        for (const wid of wonIds) {
          trackEventServerFireAndForget("hand_won", wid, { tableId: tid, handId: hid }, "server");
        }
        void evaluateHandChipDumpSuspect({ tableId: this.tableId, seatSummaries });
      } catch (statErr) {
        logger.warn("poker_stats_increment_failed", {
          tableId: this.tableId,
          reason: statErr?.message || "unknown",
        });
      }

      if (settledHandHistoryId) {
        void require("../services/phase3HandArchiveService")
          .onHandSettled({
            handId: this.currentHandId,
            handHistoryId: settledHandHistoryId,
            tableId: this.tableId,
            gameType: "poker",
            dealerSeatIndex: this.dealerIndex,
            smallBlind: this.smallBlind,
            bigBlind: this.bigBlind,
            startedAt: this.handStartedAt,
            endedAt: Date.now(),
            community,
            pot: this.lastHand?.pot ?? 0,
            rake,
            winners: winnerSummaries,
            handCategory: handCategory || null,
            seats: seatSummaries,
            actions: this.lastHand?.actions || [...this.currentHandActions],
            auditLog,
            reason: meta.reason || (showdownRanks ? "showdown" : "fold"),
          })
          .catch((archiveErr) => {
            logger.warn("phase3_hand_archive_failed", {
              tableId: this.tableId,
              handId: this.currentHandId,
              reason: archiveErr?.message || "unknown",
            });
          });
      }
    } catch (e) {
      // Log settlement failure but keep the table running — chips are already
      // updated in the live engine; blocking the next hand strands all players.
      this.logSuspicious("financial_settlement_failed", {
        tableId: this.tableId,
        handId: this.currentHandId,
        reason: e?.message || "unknown",
      });
    }

    // Prepare next hand: move dealer to next alive seat
    const order = this.seatOrderFrom(this.dealerIndex);
    const nextDealer = order.find((i) => this.seats[i].chips > 0) ?? this.dealerIndex;
    this.dealerIndex = nextDealer;

    this.running = false;
    this.clearActionScheduling();
    if (manageLifecycle) {
      await this.broadcastState(true); // reveal at end while round is showdown
      this.setRound("idle");
      this.currentHandId = null;
      this.currentHandActions = [];
      this.processedActionIds = new Set();
      // Short delay then auto-start the next hand when enough players remain.
      this.scheduleNextHand();
    }
    // When the caller manages lifecycle (showdown), it schedules the next hand
    // itself AFTER the winner banner so there is a clean gap between hands.
  }

  getPublicState(forUserId) {
    const turnSeatIndex = this.currentIndex;
    const turnSeat = this.seats[turnSeatIndex];
    const turnUserId = turnSeat?.userId || null;
    const isActor =
      forUserId != null && turnUserId != null && String(forUserId) === String(turnUserId);
    const rawSpec = isActor ? this.computeTurnActionSpec(turnSeatIndex) : null;
    const actionSpec = normalizeClientActionSpec(rawSpec, isActor);
    const lobby = this.buildLobbyStateFields();

    return {
      tableId: this.tableId,
      stateRevision: toSafeInt(this.stateRevision, 0),
      serverTime: Date.now(),
      round: this.round,
      frozen: this.frozen === true,
      ...lobby,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      lastRaiseAmount: this.lastRaiseAmount,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buyIn: this.buyIn,
      minimumBet: this.minimumBet,
      sbSeatIndex: this.sbSeatIndex,
      bbSeatIndex: this.bbSeatIndex,
      dealerSeatIndex: this.dealerIndex,
      turnUserId,
      actionDeadline: this.actionDeadline,
      turnSeconds: this.turnSeconds,
      botFillDeadline: this.botFillDeadline,
      waitForPlayersDeadline: this.waitForPlayersDeadline,
      waitForPlayersSeconds: Math.ceil(POKER_TIMINGS.WAIT_FOR_PLAYERS_MS / 1000),
      lastHand: this.lastHand,
      actionSpec,
      lastAction: this.computeLastTableAction(),
      seats: this.seats.map((s, i) => ({
        seatIndex: i,
        userId: s.userId,
        name: s.name,
        avatar: s.avatar,
        isBot: !!s.isBot,
        chips: s.chips,
        inHand: s.inHand,
        folded: s.folded,
        allIn: s.allIn,
        hole: mapHoleForClientView({
          round: this.round,
          lastHand: this.lastHand,
          seat: s,
          seatIndex: i,
          forUserId,
          showdownRevealedSeats: this.showdownRevealedSeats,
        }),
        bet: s.bet,
        playerState: s.playerState || PLAYER_STATE.SEATED,
        reconnectDeadline: s.reconnectDeadline || null,
        lastAction: s.lastAction && typeof s.lastAction === "object" ? { ...s.lastAction } : null,
        cosmetics:
          s.cosmetics && typeof s.cosmetics === "object"
            ? {
                tableTheme: s.cosmetics.tableTheme || null,
                cardSkin: s.cosmetics.cardSkin || null,
              }
            : { tableTheme: null, cardSkin: null },
      })),
    };
  }

  async broadcastState(showdown = false) {
    // Persist snapshot first, then derive outgoing events from state.
    await this.saveSnapshot({
      finished: !this.running && (this.round === "idle" || this.round === "showdown"),
    });
    await this.syncMongoTableStatus();

    const room = `tg:${this.tableId}`;
    const pub = this.getPublicState(null);
    const spectatorDelay = require("../services/spectatorDelayService");
    spectatorDelay.enqueueSpectatorState(this.tableId, pub);

    try {
      const sockets = await this.nsp.in(room).fetchSockets();
      for (const sock of sockets) {
        const uid = sock.userId;
        if (!uid) continue;
        const isSeated = this.seats.some((s) => String(s.userId) === String(uid));
        const isSpectator = this.spectatorUserIds.has(String(uid));
        const me = this.getPublicState(uid);
        if (isSeated) {
          sock.emit("table_state", pub);
          sock.emit("state", pub);
          sock.emit("table_state_me", me);
          sock.emit("state:me", me);
          void require("../services/presenceService")
            .markPlaying(uid, { gameType: "poker", tableId: this.tableId })
            .catch(() => {});
        } else if (isSpectator) {
          const delayed = spectatorDelay.getLatestDelayedState(this.tableId) || pub;
          sock.emit("table_state", delayed);
          sock.emit("state", delayed);
          void require("../services/presenceService")
            .markWatching(uid, { gameType: "poker", tableId: this.tableId })
            .catch(() => {});
        }
      }
    } catch (e) {
      metrics.errorsTotal.inc({ type: "broadcast_state_failed" });
      logger.error("broadcast_state_failed", {
        tableId: this.tableId,
        reason: e?.message || "unknown",
      });
    }
  }

  /**
   * Admin: end the current hand and settle. Uses same settlement path as normal endings.
   * @returns {Promise<{ ok: boolean, path?: string, skipped?: boolean, reason?: string }>}
   */
  async adminForceEndHand() {
    const lockAcquired = await this.acquireActionLock();
    if (!lockAcquired) {
      return { ok: false, reason: "LOCK_BUSY" };
    }
    try {
      if (!this.running) {
        return { ok: true, skipped: true, reason: "not_running" };
      }

      this.clearTurnTimer();
      this.clearBotThinkTimer();
      this.appendHandAction({ type: "admin_force_end", playerId: null, seatIndex: -1 });

      if (this.aliveCount() <= 1) {
        await this.finishHandByFold();
        return { ok: true, path: "fold_win" };
      }

      if (this.community.length >= 3) {
        await this.showdown();
        return { ok: true, path: "showdown" };
      }

      const aliveIdxs = [];
      for (let i = 0; i < this.seats.length; i++) {
        if (this.seats[i].inHand && !this.seats[i].folded) aliveIdxs.push(i);
      }
      const potTotal = this.pot;
      const payouts = new Map();
      if (potTotal > 0 && aliveIdxs.length > 0) {
        const share = Math.floor(potTotal / aliveIdxs.length);
        let remainder = potTotal - share * aliveIdxs.length;
        for (const idx of aliveIdxs) {
          let add = share;
          if (remainder > 0) {
            add += 1;
            remainder -= 1;
          }
          if (add > 0) payouts.set(idx, add);
        }
      }

      await this.persistAndPrepareNext(this.community, payouts, aliveIdxs, {
        reason: "admin_force_split",
      });
      return { ok: true, path: "admin_split" };
    } catch (e) {
      logger.error("admin_force_end_failed", {
        tableId: this.tableId,
        reason: e?.message || "unknown",
      });
      return { ok: false, reason: e?.message || "unknown" };
    } finally {
      await this.releaseActionLock();
    }
  }

  async handleAction(userId, payload) {
    const lockAcquired = await this.acquireActionLock();
    if (!lockAcquired) {
      this.logSuspicious("duplicate_action_while_locked", { userId, payload });
      return { status: "rejected", reason: "INVALID_ACTION" };
    }

    try {
      if (this.frozen) {
        return { status: "rejected", reason: "TABLE_FROZEN" };
      }
      if (!this.running) {
        this.logSuspicious("action_while_not_running", { userId, payload, round: this.round });
        return { status: "rejected", reason: "INVALID_ACTION" };
      }

      if (!["preflop", "flop", "turn", "river"].includes(this.round)) {
        this.logSuspicious("action_in_illegal_round", { userId, payload, round: this.round });
        return { status: "rejected", reason: "INVALID_ACTION" };
      }

      const idx = this.findSeatIndexByUser(userId);
      if (idx !== this.currentIndex) {
        this.logSuspicious("not_turn_player_action", {
          userId,
          actorSeatIndex: idx,
          turnSeatIndex: this.currentIndex,
        });
        return { status: "rejected", reason: "NOT_YOUR_TURN" };
      }
      const actorSeat = this.seats[idx];
      if (
        !actorSeat?.inHand ||
        actorSeat.folded ||
        actorSeat.playerState === PLAYER_STATE.WAITING ||
        actorSeat.playerState === PLAYER_STATE.SITTING_OUT
      ) {
        return { status: "rejected", reason: "NOT_IN_HAND" };
      }
      if (this.seats[idx]?.isBot) {
        this.logSuspicious("human_action_on_bot_seat", { userId, idx });
        return { status: "rejected", reason: "INVALID_ACTION" };
      }

      const { action, amount, actionId } = payload || {};
      const normalizedAction = String(action || "").toLowerCase();
      const normalizedActionId =
        typeof actionId === "string" && actionId.trim().length > 0
          ? actionId.trim().slice(0, 128)
          : null;

      if (!normalizedActionId) {
        this.logSuspicious("missing_action_id", { userId });
        return { status: "rejected", reason: "MISSING_ACTION_ID" };
      }

      const spec = this.computeTurnActionSpec(idx);
      if (!spec || !spec.allowed || !spec.allowed.includes(normalizedAction)) {
        this.logSuspicious("action_not_allowed", {
          userId,
          normalizedAction,
          allowed: spec?.allowed || [],
        });
        return { status: "rejected", reason: "INVALID_ACTION" };
      }

      let raiseExtra = null;
      if (normalizedAction === "raise") {
        const parsed = Number(amount);
        if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed) {
          this.logSuspicious("raise_non_integer_amount", { userId, amount });
          return { status: "rejected", reason: "INVALID_ACTION" };
        }
        const v = toSafeInt(parsed, 0);
        if (v < spec.minRaise || v > spec.maxRaise) {
          this.logSuspicious("raise_amount_out_of_bounds", {
            userId,
            amount: v,
            minRaise: spec.minRaise,
            maxRaise: spec.maxRaise,
          });
          return { status: "rejected", reason: "INVALID_ACTION" };
        }
        const actorSeat = this.seats[idx];
        const totalAfter = toSafeInt(actorSeat.bet, 0) + spec.callAmount + v;
        const tableMin = Math.max(1, toSafeInt(this.minimumBet, this.bigBlind));
        const isAllInRaise = actorSeat.chips <= spec.callAmount + v;
        if (!isAllInRaise && totalAfter < tableMin) {
          this.logSuspicious("raise_below_table_minimum", {
            userId,
            totalAfter,
            tableMin,
          });
          return { status: "rejected", reason: "INVALID_ACTION" };
        }
        raiseExtra = v;
      }

      const claimedActionId = await this.claimActionId(normalizedActionId);
      if (!claimedActionId) {
        this.logSuspicious("duplicate_action_id", { userId, actionId: normalizedActionId });
        // Reject so clients clear in-flight UI; no broadcast occurs for duplicates.
        return { status: "rejected", reason: "DUPLICATE_ACTION" };
      }

      if (normalizedAction === "fold") {
        this.applyFold(idx);
        this.recordSeatAction(idx, "fold");
        this.appendHandAction({
          type: "fold",
          seatIndex: idx,
          playerId: this.seats[idx]?.userId,
        });
      } else if (normalizedAction === "check") {
        if (spec.callAmount !== 0 || !spec.canCheck) {
          this.logSuspicious("check_when_not_free", { userId, callAmount: spec.callAmount });
          return { status: "rejected", reason: "INVALID_ACTION" };
        }
        this.recordSeatAction(idx, "check", 0);
        this.appendHandAction({
          type: "check",
          seatIndex: idx,
          playerId: this.seats[idx]?.userId,
          amount: 0,
        });
      } else if (normalizedAction === "call") {
        // "call" acts as check when callAmount == 0
        const beforeBet = this.seats[idx].bet;
        const beforeChips = this.seats[idx].chips;
        this.applyCall(idx);
        const paid = Math.max(0, beforeChips - this.seats[idx].chips);
        const wasCheck = spec.callAmount === 0 || this.seats[idx].bet === beforeBet;
        this.recordSeatAction(idx, wasCheck ? "check" : "call", paid);
        this.appendHandAction({
          type: wasCheck ? "check" : "call",
          seatIndex: idx,
          playerId: this.seats[idx]?.userId,
          amount: paid,
        });
      } else if (normalizedAction === "raise" && raiseExtra != null) {
        const v = raiseExtra;
        this.applyBetOrRaise(idx, v);
        this.recordSeatAction(idx, "raise", v);
        this.appendHandAction({
          type: "raise",
          seatIndex: idx,
          playerId: this.seats[idx]?.userId,
          amount: v,
          callAmount: spec.callAmount,
          lastRaiseAmount: this.lastRaiseAmount,
        });
      } else {
        return { status: "rejected", reason: "INVALID_ACTION" };
      }

      this.markVoluntaryAction(idx);
      this.clearTurnTimer();
      metrics.actionsTotal.inc({ status: "accepted", action: normalizedAction || "unknown" });
      logger.info("poker_action", {
        tableId: this.tableId,
        userId,
        action: normalizedAction,
        actionId: normalizedActionId,
      });
      await this.pacedAdvanceAfterAction();
      return { status: "accepted" };
    } finally {
      await this.releaseActionLock();
    }
  }

  // --- BaseGameEngine duck-typing adapter methods (additive, ~12 new lines) ---
  // Thin pass-throughs so PokerTable is structurally compatible with the
  // BaseGameEngine interface without requiring a formal `extends` relationship
  // (its constructor signature (nsp, table, options) is incompatible with
  // BaseGameEngine's (roomId, gameType, options) so composition is used here).

  /** Maps BaseGameEngine.serialize() -> existing serializeSnapshot() */
  serialize() { return this.serializeSnapshot(); }

  /** Maps BaseGameEngine.deserialize() -> existing restoreFromSnapshot() */
  deserialize(data) { return this.restoreFromSnapshot(data); }

  /** Maps BaseGameEngine.emitState() -> existing broadcastState() */
  emitState() { return this.broadcastState(); }

  /** Maps BaseGameEngine.reconnectPlayer() -> existing onPlayerSocketConnected() */
  reconnectPlayer(userId) { return this.onPlayerSocketConnected(userId); }

  /** Maps BaseGameEngine.leavePlayer() -> existing onPlayerSocketDisconnected() */
  leavePlayer(userId) { return this.onPlayerSocketDisconnected(userId); }

  /** Maps BaseGameEngine.state (string read) -> existing this.round field.
   *  Safe: PokerTable has no prior `state` property (confirmed - uses `this.round`). */
  get state() { return this.round; }

  /** isGameFinished mirrors PokerTable's concept of not being in an active hand (idle = between hands). */
  isGameFinished() { return false; } // PokerTable tables don't permanently finish; GC handles lifecycle.
}

class GameRegistry {
  constructor(nsp, options = {}) {
    this.nsp = nsp;
    this.redis = options.redis || null;
    this.map = new Map();
    this.maxTables = Math.max(100, toSafeInt(process.env.POKER_REGISTRY_MAX_TABLES, 2000));
    this.idleEvictMs = Math.max(60000, toSafeInt(process.env.POKER_REGISTRY_IDLE_EVICT_MS, 20 * 60 * 1000));
    this.lockManager = this.redis
      ? new RedisTableLockManager(this.redis)
      : new InMemoryTableLockManager();
    this.stateStore = new RedisTableStateStore(this.redis);
  }

  markAccess(tableId) {
    const entry = this.map.get(tableId);
    if (!entry) return;
    entry.lastAccessAt = Date.now();
  }

  prune() {
    const now = Date.now();
    if (this.map.size <= this.maxTables) return;
    for (const [tableId, entry] of this.map.entries()) {
      const idleFor = now - (entry.lastAccessAt || 0);
      if (idleFor >= this.idleEvictMs && !entry.game.running && !entry.game.starting) {
        this.map.delete(tableId);
      }
      if (this.map.size <= this.maxTables) break;
    }
    metrics.activeTables.set(this.map.size);
  }

  async get(tableId) {
    if (this.map.has(tableId)) {
      this.markAccess(tableId);
      return this.map.get(tableId).game;
    }
    const table = await Table.findById(tableId).populate({
      path: "seats.user",
      select: "name profileImg",
    });
    if (!table) return null;
    const gt = new PokerTable(this.nsp, table, {
      lockManager: this.lockManager,
      redis: this.redis,
      stateStore: this.stateStore,
    });

    // Crash/restart recovery: restore from Redis snapshot if exists.
    const snapshot = await this.stateStore.load(tableId);
    if (snapshot) {
      gt.restoreFromSnapshot(snapshot);
      const handActive =
        snapshot.running === true ||
        (snapshot.round && String(snapshot.round) !== "idle");
      if (handActive) {
        try {
          const { registerPokerRecoveryWatch } = require("../services/tableGcService");
          registerPokerRecoveryWatch(tableId);
        } catch (_) {
          // GC service optional during tests
        }
      }
      await gt.reconcileEngineWithMongo(table);
    }

    await gt.applyCosmeticsToSeats();

    if (!gt.running && gt.round === "idle" && !gt.frozen && gt.humanSeatCount() > 0) {
      try {
        await gt.bootstrapLobbyStart();
      } catch (e) {
        logger.warn("poker_registry_bootstrap_failed", {
          tableId: String(tableId),
          reason: e?.message || "unknown",
        });
      }
    }

    this.map.set(tableId, { game: gt, lastAccessAt: Date.now() });
    this.prune();
    metrics.activeTables.set(this.map.size);
    return gt;
  }

  async getSnapshotPublicState(tableId, forUserId) {
    const snapshot = await this.stateStore.load(tableId);
    if (!snapshot) return null;
    const state = PokerTable.publicStateFromSnapshot(snapshot, forUserId);
    await cosmeticsService.mergeCosmeticsIntoPublicState(state);
    return state;
  }
}

function initTableGame(io, options = {}) {
  attachCosmeticsEquippedCache(options.redis || null);
  const nsp = io.of("/table-game");
  const registry = new GameRegistry(nsp, options);
  const security = new SocketSecurityGuard();
  activeRegistry = registry;

  // Auth
  nsp.use((socket, next) => {
    try {
      const token = getTokenFromHandshake(socket);
      if (!token) return next(new Error("Authentication token missing"));
      const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      socket.userId = decoded.userId;
      socket.userIp = security.getIp(socket);
      const sec = security.onConnection(socket, socket.userId);
      if (sec.blocked) return next(new Error(sec.reason || "Rate limited"));
      metrics.activePlayers.inc();
      next();
    } catch (err) {
      next(new Error("Invalid token"));
    }
  });

  nsp.on("connection", (socket) => {
    async function handleJoinTable({ tableId, clientSeed }) {
      try {
        if (!tableId) return;
        const table = await Table.findById(tableId).select("seats vacatingPlayers");
        if (!table) return;
        const uid = String(socket.userId);
        const isSeated = table.seats.some((s) => String(s.user) === uid);
        const isVacating = (table.vacatingPlayers || []).some(
          (v) => String(v.user) === uid && new Date(v.vacateUntil).getTime() > Date.now()
        );
        if (!isSeated && !isVacating) return;
        socket.join(`tg:${tableId}`);

        const game = await registry.get(String(tableId));
        if (!game) return;

        game.onPlayerSocketConnected(socket.userId);
        await game.resyncTurnAfterReconnect(socket.userId);
        const idx = game.findSeatIndexByUser(socket.userId);
        if (idx >= 0 && typeof clientSeed === "string" && clientSeed.trim()) {
          game.seats[idx].clientSeed = clientSeed.trim().slice(0, 128);
        }

        if (game.round === "idle" && !game.running && !game.frozen) {
          await game.bootstrapLobbyStart();
        } else {
          await game.refreshSeatsFromDb();
          await game.broadcastState();
        }

        const p = game.getPublicState(null);
        const m = game.getPublicState(socket.userId);
        socket.emit("table_state", p);
        socket.emit("state", p);
        socket.emit("table_state_me", m);
        socket.emit("reconnect_state", m);
        socket.emit("state:me", m);

        socket.emit("table_event", { type: "joined", tableId: String(tableId) });
      } catch (e) {
        metrics.errorsTotal.inc({ type: "subscribe_table_failed" });
        logger.error("subscribe_table_failed", {
          userId: socket.userId,
          tableId,
          reason: e?.message || "unknown",
        });
      }
    }

    socket.on("join_table", handleJoinTable);
    socket.on("subscribe-table", handleJoinTable);

    socket.on("time_sync", (payload, ack) => {
      const serverTime = Date.now();
      const body = {
        serverTime,
        clientTs: payload?.clientTs ?? null,
        turnSeconds: POKER_TIMINGS.TURN_SECONDS,
        turnActionMs: POKER_TIMINGS.TURN_SECONDS * 1000,
      };
      if (typeof ack === "function") ack(body);
      else socket.emit("time_sync", body);
    });

    async function handleWatchTable({ tableId }) {
      try {
        if (!tableId) return;
        const table = await Table.findById(tableId).select("gameType seats settings");
        if (!table || table.gameType !== "poker") return;
        const seated = table.seats.some((s) => String(s.user) === String(socket.userId));
        if (seated) {
          return handleJoinTable({ tableId });
        }
        if (table.settings && table.settings.allowSpectators === false) {
          socket.emit("table_event", { type: "spectating_denied", tableId: String(tableId) });
          return;
        }
        socket.isSpectator = true;
        socket.join(`tg:${tableId}`);
        const game = await registry.get(String(tableId));
        if (game) {
          game.spectatorUserIds.add(String(socket.userId));
          const pub = game.getPublicState(null);
          socket.emit("table_state", pub);
          socket.emit("state", pub);
          socket.emit("table_state_me", pub);
          socket.emit("reconnect_state", pub);
          socket.emit("state:me", pub);
        }
        socket.emit("table_event", { type: "spectating", tableId: String(tableId) });
      } catch (e) {
        logger.error("watch_table_failed", {
          userId: socket.userId,
          tableId,
          reason: e?.message || "unknown",
        });
      }
    }

    socket.on("watch_table", handleWatchTable);

    socket.on("leave_table", async ({ tableId }) => {
      if (!tableId) return;
      socket.leave(`tg:${tableId}`);
      socket.emit("table_event", { type: "left", tableId: String(tableId) });
    });

    socket.on("start-if-ready", async ({ tableId }) => {
      if (!tableId) return;
      const tbl = await Table.findById(tableId).select("seats vacatingPlayers").lean();
      if (!tbl) return;
      const uid = String(socket.userId);
      const isSeated = tbl.seats.some((s) => String(s.user) === uid);
      const isVacating = (tbl.vacatingPlayers || []).some(
        (v) => String(v.user) === uid && new Date(v.vacateUntil).getTime() > Date.now()
      );
      if (!isSeated && !isVacating) return;
      const game = await registry.get(String(tableId));
      if (game) {
        await game.bootstrapLobbyStart();
      }
    });

    socket.on("resync_turn", async ({ tableId }) => {
      try {
        if (!tableId) return;
        const game = await registry.get(String(tableId));
        if (!game) return;
        await game.resyncTurnAfterReconnect(socket.userId);
        const priv = game.getPublicState(socket.userId);
        socket.emit("table_state_me", priv);
        socket.emit("state:me", priv);
        socket.emit("reconnect_state", priv);
        await game.broadcastState();
      } catch (e) {
        logger.error("resync_turn_failed", {
          userId: socket.userId,
          tableId,
          reason: e?.message || "unknown",
        });
      }
    });

    socket.on("action", async ({ tableId, action, amount, actionId }) => {
      const sec = security.onAction(socket.userId, socket.userIp, actionId);
      if (sec.blocked) {
        metrics.actionsTotal.inc({ status: "blocked", action: String(action || "unknown") });
        socket.emit("invalid_move", { status: "rejected", reason: sec.reason, retryAfterMs: sec.retryAfterMs });
        return;
      }
      const game = await registry.get(String(tableId));
      if (!game) return;
      const res = await game.handleAction(socket.userId, { action, amount, actionId });
      if (res && res.status === "rejected") {
        metrics.actionsTotal.inc({ status: "rejected", action: String(action || "unknown") });
        socket.emit("invalid_move", res);
        socket.emit("action_result", res);
      } else {
        socket.emit("action_result", { status: "accepted" });
      }
    });

    socket.on("table_chat", (payload, ack) => {
      try {
        const { tableId, body, emoji } = payload || {};
        if (!tableId) return;
        const room = `tg:${tableId}`;
        if (!socket.rooms.has(room)) return;

        const rate = tableChat.checkRate(socket.userId);
        if (!rate.ok) {
          if (typeof ack === "function") {
            ack({ ok: false, reason: "rate_limited", retryAfterMs: rate.retryAfterMs });
          }
          return;
        }

        // Resolve display identity server-side from the seated player so names
        // can't be spoofed. Falls back to client-supplied hints for spectators.
        let name = payload?.name;
        let avatar = payload?.avatar;
        const entry = registry.map.get(String(tableId));
        const game = entry?.game;
        if (game) {
          const idx = game.findSeatIndexByUser(socket.userId);
          if (idx >= 0 && game.seats[idx]) {
            name = game.seats[idx].name || name;
            avatar = game.seats[idx].avatar || avatar;
          }
        }

        const built = tableChat.buildChatMessage({
          userId: socket.userId,
          name,
          avatar,
          body,
          emoji,
        });
        if (!built.ok) {
          if (typeof ack === "function") ack(built);
          return;
        }
        nsp.to(room).emit("table_chat", built.message);
        if (typeof ack === "function") ack({ ok: true, id: built.message.id });
      } catch (e) {
        logger.error("table_chat_failed", {
          userId: socket.userId,
          reason: e?.message || "unknown",
        });
      }
    });

    socket.on("disconnect", () => {
      security.onDisconnect(socket, socket.userId);
      metrics.activePlayers.dec();
      if (socket.isSpectator) return;
      for (const { game } of registry.map.values()) {
        const idx = game.findSeatIndexByUser(socket.userId);
        if (idx >= 0) {
          game.onPlayerSocketDisconnected(socket.userId);
          void game.broadcastState();
        }
      }
    });
  });
}

let activeRegistry = null;

async function refreshCosmeticsForUserOnTables(userId) {
  if (!activeRegistry || !userId) return;
  const map = await cosmeticsService.resolveEquippedPayloadForUsers([userId]);
  const c = map.get(String(userId)) || { tableTheme: null, cardSkin: null };
  const uidStr = String(userId);
  for (const { game } of activeRegistry.map.values()) {
    const idx = game.findSeatIndexByUser(userId);
    if (idx >= 0) {
      game.seats[idx].cosmetics = { ...c };
      const room = `tg:${game.tableId}`;
      // Persist seat cosmetics (bumps stateRevision), then targeted emit — snapshot stays source of truth.
      try {
        await game.saveSnapshot({ finished: false });
        game.nsp.to(room).emit("cosmetics_updated", {
          tableId: String(game.tableId),
          userId: uidStr,
          cosmetics: { tableTheme: c.tableTheme, cardSkin: c.cardSkin },
          stateRevision: toSafeInt(game.stateRevision, 0),
        });
      } catch (_) {
        /* ignore emit / snapshot errors */
      }
    }
  }
}

function evictTableFromRegistry(tableId) {
  if (!activeRegistry) return false;
  const tid = String(tableId);
  const entry = activeRegistry.map.get(tid);
  if (!entry) return false;
  const game = entry.game;
  if (game) {
    game.clearActionScheduling?.();
    game.clearBotFillTimer?.();
    game.clearWaitForPlayersTimer?.();
    game.running = false;
  }
  activeRegistry.map.delete(tid);
  metrics.activeTables.set(activeRegistry.map.size);
  return true;
}

async function resetLivePokerTableWhenEmpty(tableId) {
  const tid = String(tableId);
  if (!activeRegistry) return false;

  const entry = activeRegistry.map.get(tid);
  if (entry?.game) {
    const table = await Table.findById(tid).select(
      "seats smallBlind bigBlind minBuyIn maxBuyIn capacity status gameType"
    );
    await entry.game.resetToEmptyIdle(table || { seats: [] });
  } else {
    const table = await Table.findById(tid).select(
      "seats smallBlind bigBlind minBuyIn maxBuyIn capacity"
    );
    if (table && activeRegistry.stateStore?.delete) {
      await activeRegistry.stateStore.delete(tid);
    }
    const room = `tg:${tid}`;
    const emptyPayload = {
      tableId: tid,
      stateRevision: 1,
      serverTime: Date.now(),
      round: "idle",
      frozen: false,
      capacity: normalizeCapacity(table?.capacity),
      seatedCount: 0,
      playersNeeded: POKER_MIN_PLAYERS,
      tableStatus: "waiting",
      canStart: false,
      community: [],
      pot: 0,
      currentBet: 0,
      minRaise: toSafeInt(table?.bigBlind, 0),
      lastRaiseAmount: toSafeInt(table?.bigBlind, 0),
      smallBlind: toSafeInt(table?.smallBlind, 0),
      bigBlind: toSafeInt(table?.bigBlind, 0),
      seats: [],
      waitForPlayersDeadline: null,
    };
    activeRegistry.nsp.to(room).emit("table_state", emptyPayload);
    activeRegistry.nsp.to(room).emit("state", emptyPayload);
  }

  evictTableFromRegistry(tid);
  return true;
}

async function vacateLiveEngineSeat(tableId, userId, meta = {}) {
  if (!activeRegistry) return false;
  const game = await activeRegistry.get(String(tableId));
  if (!game) return false;
  return game.applyEngineVacate(userId, meta);
}

async function removeLiveHumanSeat(tableId, userId) {
  if (!activeRegistry) return false;
  const game = await activeRegistry.get(String(tableId));
  if (!game) return false;
  return game.removeLiveHumanSeat(userId);
}

async function restoreLiveEngineSeat(tableId, userId, meta = {}) {
  if (!activeRegistry) return false;
  const game = await activeRegistry.get(String(tableId));
  if (!game) return false;
  return game.restoreVacatedHumanSeat(userId, meta);
}

async function syncLivePokerTableAfterJoin(tableId) {
  if (!activeRegistry) return;
  try {
    const game = await activeRegistry.get(String(tableId));
    if (!game) return;
    if (game.round === "idle" && !game.running && !game.frozen) {
      await game.bootstrapLobbyStart();
    } else {
      await game.refreshSeatsFromDb();
      await game.broadcastState();
    }
  } catch (e) {
    logger.error("sync_live_poker_after_join_failed", {
      tableId: String(tableId),
      reason: e?.message || "unknown",
    });
  }
}

async function syncLivePokerTableAfterLeave(tableId) {
  if (!activeRegistry) return;
  const game = await activeRegistry.get(String(tableId));
  if (!game) return;
  await game.refreshSeatsFromDb();
  game.clearWaitForPlayersTimer();
  if (game.humanSeatCount() < 1) {
    await resetLivePokerTableWhenEmpty(tableId);
    return;
  }
  if (game.round === "idle" && !game.running && !game.frozen) {
    if (game.humanSeatCount() >= 1) {
      await game.bootstrapLobbyStart();
    } else {
      game.scheduleWaitForPlayers();
      await game.broadcastState();
    }
  } else if (game.eligibleHumanCount() >= POKER_MIN_PLAYERS) {
    await game.startIfReady({ refreshFromDb: false, allowBotFill: true });
  } else {
    await game.broadcastState();
  }
}

function getTableGameDebugSnapshot(tableId) {
  if (!activeRegistry) return null;
  const entry = activeRegistry.map.get(String(tableId));
  if (!entry || !entry.game) return null;
  const game = entry.game;
  return {
    tableId: game.tableId,
    round: game.round,
    running: game.running,
    seated: game.seats.length,
    pot: game.pot,
    currentBet: game.currentBet,
    turnUserId: game.seats[game.currentIndex]?.userId || null,
    handId: game.currentHandId,
  };
}

function buildAdminRealtimeTablePayload(game) {
  if (!game) return null;
  const pub = game.getPublicState(null);
  return {
    ...pub,
    running: game.running,
    starting: game.starting,
    currentHandId: game.currentHandId,
    processedActionIdsCount:
      game.processedActionIds instanceof Set ? game.processedActionIds.size : 0,
  };
}

async function getLiveTableGameForAdmin(tableId) {
  if (!activeRegistry) return null;
  return activeRegistry.get(String(tableId));
}

async function adminForceEndHandTable(tableId) {
  const game = await getLiveTableGameForAdmin(tableId);
  if (!game) return { ok: false, reason: "TABLE_NOT_IN_MEMORY" };
  return game.adminForceEndHand();
}

module.exports = {
  initTableGame,
  PokerTable,
  getTableGameDebugSnapshot,
  evictTableFromRegistry,
  resetLivePokerTableWhenEmpty,
  syncLivePokerTableAfterJoin,
  syncLivePokerTableAfterLeave,
  vacateLiveEngineSeat,
  removeLiveHumanSeat,
  restoreLiveEngineSeat,
  buildAdminRealtimeTablePayload,
  getLiveTableGameForAdmin,
  adminForceEndHandTable,
  refreshCosmeticsForUserOnTables,
  /** @internal unit tests — hole visibility contract */
  mapHoleForClientView,
};
