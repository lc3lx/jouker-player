const crypto = require("crypto");
const { CheckpointManager } = require("./CheckpointManager");
const AntiCheatValidator = require("./AntiCheatValidator");

const VALID_TRANSITIONS = {
  waiting: ["countdown"],
  countdown: ["starting", "waiting"],
  starting: ["playing", "waiting"],
  playing: ["finished"],
  finished: ["settlement_pending"],
  settlement_pending: ["settled"],
  settled: [],
};

const COUNTDOWN_SEC = parseInt(process.env.PARKOUR_COUNTDOWN_SEC || "5", 10);
const DISCONNECT_FORFEIT_MS = parseInt(process.env.PARKOUR_DISCONNECT_FORFEIT_MS || "60000", 10);
const RACE_MAX_DURATION_MS = parseInt(process.env.PARKOUR_RACE_MAX_MS || "600000", 10);

/** Position payout weights by finish order (1st, 2nd, 3rd...) — normalized at settlement */
const POSITION_WEIGHTS = [10, 6, 4, 3, 2, 2, 1, 1, 1, 1];

class ParkourGame {
  /**
   * @param {object} raceDoc - Mongo ParkourRace lean or hydrated
   * @param {object} trackDoc - ParkourCheckpoint track
   */
  constructor(raceDoc, trackDoc) {
    this.raceId = raceDoc.raceId;
    this.mongoId = raceDoc._id;
    this.trackId = raceDoc.trackId;
    this.state = raceDoc.state || "waiting";
    this.entryFee = raceDoc.entryFee;
    this.minPlayers = raceDoc.minPlayers || 2;
    this.maxPlayers = raceDoc.maxPlayers || 20;
    this.sessionId = raceDoc.sessionId || crypto.randomUUID();
    this.countdownStartedAt = raceDoc.countdownStartedAt ? new Date(raceDoc.countdownStartedAt).getTime() : 0;
    this.raceStartedAt = raceDoc.raceStartedAt ? new Date(raceDoc.raceStartedAt).getTime() : 0;
    this.nextFinishOrder = raceDoc.nextFinishOrder || 1;
    this.finishedCount = raceDoc.finishedCount || 0;

    this.checkpointManager = new CheckpointManager(trackDoc);
    this.antiCheat = new AntiCheatValidator();
    this.antiCheat.resetNonces(raceDoc.eventNonces || []);

    this.players = (raceDoc.participants || []).map((p) => ({
      userId: String(p.userId),
      seatIndex: p.seatIndex,
      displayName: p.displayName || `Player ${p.seatIndex + 1}`,
      buyIn: p.buyIn,
      ready: !!p.ready,
      status: p.status || "active",
      lastCheckpoint: p.lastCheckpoint ?? -1,
      checkpointsReached: [...(p.checkpointsReached || [])],
      finishOrder: p.finishOrder,
      finishTimeMs: p.finishTimeMs,
      lastPosition: { ...(p.lastPosition || { x: 0, y: 0, z: 0, t: 0 }) },
      disconnectedAt: p.disconnectedAt ? new Date(p.disconnectedAt).getTime() : null,
      socketId: p.socketId || null,
      finishNonce: null,
    }));
  }

  canTransition(to) {
    return (VALID_TRANSITIONS[this.state] || []).includes(to);
  }

  transition(to) {
    if (!this.canTransition(to)) {
      return { success: false, reason: "invalid_state_transition", from: this.state, to };
    }
    this.state = to;
    return { success: true, state: this.state };
  }

  getPlayer(userId) {
    return this.players.find((p) => String(p.userId) === String(userId)) || null;
  }

  getPlayerBySeat(seatIndex) {
    return this.players.find((p) => p.seatIndex === seatIndex) || null;
  }

  addPlayer({ userId, displayName, buyIn, socketId }) {
    if (this.state !== "waiting") return { success: false, reason: "race_not_waiting" };
    if (this.players.length >= this.maxPlayers) return { success: false, reason: "race_full" };
    if (this.getPlayer(userId)) return { success: false, reason: "already_joined" };

    const seatIndex = this.players.length;
    this.players.push({
      userId: String(userId),
      seatIndex,
      displayName: displayName || `Player ${seatIndex + 1}`,
      buyIn,
      ready: false,
      status: "active",
      lastCheckpoint: -1,
      checkpointsReached: [],
      finishOrder: null,
      finishTimeMs: null,
      lastPosition: { ...this.checkpointManager.spawnPoint, t: Date.now() },
      disconnectedAt: null,
      socketId,
    });
    return { success: true, seatIndex };
  }

  setReady(userId, ready = true) {
    if (this.state !== "waiting") return { success: false, reason: "not_waiting" };
    const p = this.getPlayer(userId);
    if (!p) return { success: false, reason: "not_in_race" };
    p.ready = !!ready;
    return { success: true, ready: p.ready };
  }

  allReady() {
    const active = this.players.filter((p) => p.status !== "forfeited");
    return active.length >= this.minPlayers && active.every((p) => p.ready);
  }

  startCountdownIfReady() {
    if (this.state !== "waiting" || !this.allReady()) return null;
    this.transition("countdown");
    this.countdownStartedAt = Date.now();
    return { countdownSec: COUNTDOWN_SEC, startedAt: this.countdownStartedAt };
  }

  tickCountdown(now = Date.now()) {
    if (this.state !== "countdown") return null;
    const elapsed = (now - this.countdownStartedAt) / 1000;
    if (elapsed < COUNTDOWN_SEC) {
      return { remaining: Math.ceil(COUNTDOWN_SEC - elapsed), phase: "countdown" };
    }
    this.transition("starting");
    return { remaining: 0, phase: "starting" };
  }

  startRace(now = Date.now()) {
    if (this.state !== "starting" && this.state !== "countdown") {
      return { success: false, reason: "invalid_state" };
    }
    this.state = "playing";
    this.raceStartedAt = now;
    for (const p of this.players) {
      p.lastPosition = { ...this.checkpointManager.spawnPoint, t: now };
      p.lastCheckpoint = -1;
    }
    return { success: true, raceStartedAt: this.raceStartedAt };
  }

  updatePosition(userId, position, nonce) {
    if (this.state !== "playing") return { success: false, reason: "not_playing" };
    const p = this.getPlayer(userId);
    if (!p || p.status === "forfeited" || p.status === "finished") {
      return { success: false, reason: "player_inactive" };
    }

    const nonceCheck = this.antiCheat.consumeNonce(nonce);
    if (!nonceCheck.valid) return { success: false, reason: nonceCheck.reason };

    const pos = {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
      t: Number(position.t) || Date.now(),
    };

    const moveCheck = this.antiCheat.validateMovement(p.lastPosition, pos);
    if (!moveCheck.valid) return { success: false, reason: moveCheck.reason, ...moveCheck };

    p.lastPosition = pos;
    if (p.status === "disconnected") {
      p.status = "active";
      p.disconnectedAt = null;
    }
    return { success: true };
  }

  reachCheckpoint(userId, checkpointIndex, position, nonce) {
    if (this.state !== "playing") return { success: false, reason: "not_playing" };
    const p = this.getPlayer(userId);
    if (!p || p.status === "forfeited" || p.status === "finished") {
      return { success: false, reason: "player_inactive" };
    }

    const nonceCheck = this.antiCheat.consumeNonce(nonce);
    if (!nonceCheck.valid) return { success: false, reason: nonceCheck.reason };

    const pos = {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
      t: Number(position.t) || Date.now(),
    };

    const tpCheck = this.antiCheat.validateTeleportAttempt(p.lastPosition, pos, 30);
    if (!tpCheck.valid) return { success: false, reason: tpCheck.reason };

    const cpCheck = this.checkpointManager.validateCheckpointReach({
      lastCheckpoint: p.lastCheckpoint,
      checkpointIndex: Number(checkpointIndex),
      position: pos,
    });
    if (!cpCheck.valid) return { success: false, reason: cpCheck.reason, ...cpCheck };

    p.lastCheckpoint = Number(checkpointIndex);
    if (!p.checkpointsReached.includes(p.lastCheckpoint)) {
      p.checkpointsReached.push(p.lastCheckpoint);
    }
    p.lastPosition = pos;

    return {
      success: true,
      checkpointIndex: p.lastCheckpoint,
      respawn: cpCheck.respawn,
    };
  }

  finishRace(userId, position, nonce) {
    if (this.state !== "playing") return { success: false, reason: "not_playing" };
    const p = this.getPlayer(userId);
    if (!p || p.status === "forfeited") return { success: false, reason: "player_inactive" };
    if (p.status === "finished") return { success: false, reason: "already_finished" };

    const nonceCheck = this.antiCheat.consumeNonce(nonce);
    if (!nonceCheck.valid) return { success: false, reason: nonceCheck.reason };
    if (p.finishNonce === nonce) return { success: false, reason: "duplicate_finish" };

    const pos = {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
      t: Number(position.t) || Date.now(),
    };

    const finishCheck = this.checkpointManager.validateFinish({
      lastCheckpoint: p.lastCheckpoint,
      position: pos,
    });
    if (!finishCheck.valid) return { success: false, reason: finishCheck.reason, ...finishCheck };

    const now = Date.now();
    const finishTimeMs = this.raceStartedAt > 0 ? now - this.raceStartedAt : 0;

    p.status = "finished";
    p.finishOrder = this.nextFinishOrder++;
    p.finishTimeMs = finishTimeMs;
    p.finishNonce = nonce;
    p.lastPosition = pos;
    this.finishedCount += 1;

    return {
      success: true,
      finishOrder: p.finishOrder,
      finishTimeMs,
      userId: p.userId,
      seatIndex: p.seatIndex,
    };
  }

  isRaceComplete() {
    const racing = this.players.filter(
      (p) => p.status !== "finished" && p.status !== "forfeited"
    );
    return racing.length === 0 || this.finishedCount >= this.players.length;
  }

  checkRaceTimeout(now = Date.now()) {
    if (this.state !== "playing" || !this.raceStartedAt) return null;
    if (now - this.raceStartedAt >= RACE_MAX_DURATION_MS) {
      for (const p of this.players) {
        if (p.status !== "finished" && p.status !== "forfeited") {
          p.status = "forfeited";
        }
      }
      return { reason: "race_timeout" };
    }
    return null;
  }

  checkDisconnectForfeits(now = Date.now()) {
    let forfeited = [];
    for (const p of this.players) {
      if (p.status !== "disconnected") continue;
      if (p.disconnectedAt && now - p.disconnectedAt >= DISCONNECT_FORFEIT_MS) {
        p.status = "forfeited";
        forfeited.push(p.userId);
      }
    }
    return forfeited;
  }

  markDisconnected(userId) {
    const p = this.getPlayer(userId);
    if (!p || p.status === "finished" || p.status === "forfeited") return;
    p.status = "disconnected";
    p.disconnectedAt = Date.now();
    p.socketId = null;
  }

  reconnect(userId, socketId) {
    const p = this.getPlayer(userId);
    if (!p) return { success: false, reason: "not_in_race" };
    if (p.status === "forfeited") return { success: false, reason: "forfeited" };
    p.socketId = socketId;
    if (p.status === "disconnected") p.status = "active";
    const respawn = this.checkpointManager.getRespawnPoint(p.lastCheckpoint);
    return { success: true, respawn, lastCheckpoint: p.lastCheckpoint, state: this.state };
  }

  completeRace() {
    if (this.state !== "playing") return { success: false };
    for (const p of this.players) {
      if (p.status !== "finished" && p.status !== "forfeited") {
        p.status = "forfeited";
      }
    }
    this.transition("finished");
    return { success: true };
  }

  /** Build gameResult for GameSettlementService */
  getGameResult() {
    const finishers = this.players
      .filter((p) => p.status === "finished" && p.finishOrder != null)
      .sort((a, b) => a.finishOrder - b.finishOrder)
      .map((p) => ({
        userId: p.userId,
        seatIndex: p.seatIndex,
        finishOrder: p.finishOrder,
        finishTimeMs: p.finishTimeMs,
      }));

    return {
      finishers,
      winnerSeatIndices: finishers.map((f) => f.seatIndex),
      positionWeights: POSITION_WEIGHTS,
    };
  }

  getPublicState(forUserId = null) {
    return {
      raceId: this.raceId,
      trackId: this.trackId,
      state: this.state,
      sessionId: this.sessionId,
      entryFee: this.entryFee,
      minPlayers: this.minPlayers,
      maxPlayers: this.maxPlayers,
      playerCount: this.players.length,
      countdownStartedAt: this.countdownStartedAt || null,
      raceStartedAt: this.raceStartedAt || null,
      totalCheckpoints: this.checkpointManager.totalCheckpoints,
      players: this.players.map((p) => ({
        userId: p.userId,
        seatIndex: p.seatIndex,
        displayName: p.displayName,
        ready: p.ready,
        status: p.status,
        lastCheckpoint: p.lastCheckpoint,
        finishOrder: p.finishOrder,
        finishTimeMs: forUserId && String(p.userId) === String(forUserId) ? p.finishTimeMs : p.finishTimeMs,
        isMe: forUserId ? String(p.userId) === String(forUserId) : false,
      })),
    };
  }

  toMongoParticipants() {
    return this.players.map((p) => ({
      userId: p.userId,
      seatIndex: p.seatIndex,
      displayName: p.displayName,
      buyIn: p.buyIn,
      ready: p.ready,
      status: p.status,
      lastCheckpoint: p.lastCheckpoint,
      checkpointsReached: p.checkpointsReached,
      finishOrder: p.finishOrder,
      finishTimeMs: p.finishTimeMs,
      lastPosition: p.lastPosition,
      disconnectedAt: p.disconnectedAt ? new Date(p.disconnectedAt) : undefined,
      socketId: p.socketId,
    }));
  }

  getEventNonces() {
    return [...this.antiCheat.usedNonces];
  }
}

ParkourGame.COUNTDOWN_SEC = COUNTDOWN_SEC;
ParkourGame.POSITION_WEIGHTS = POSITION_WEIGHTS;
ParkourGame.VALID_TRANSITIONS = VALID_TRANSITIONS;

module.exports = ParkourGame;
