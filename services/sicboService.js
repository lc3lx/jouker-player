/**
 * Sic Bo engine loop — the continuous 24/7 round driver.
 *
 * Exactly ONE node runs the loop at a time (Redis leader-lock with heartbeat/renewal);
 * all other nodes stand by and only relay socket broadcasts (fanned out by the Socket.IO
 * Redis adapter). The loop advances the persisted round state machine on a wall clock and
 * emits phase events to the "sicbo" room and personal payout events to per-user rooms.
 *
 * Mirrors services/tournamentEngineService.js (setInterval lifecycle tick), started from
 * server.js startServer().
 */
const logger = require("../utils/logger");
const roundManager = require("../games/sicbo/sicboRoundManager");
const roundState = require("../games/sicbo/sicboRoundState");
const { PHASE, BETTING_MS, RESULT_MS } = require("../games/sicbo/sicboConstants");
const { evaluateBet } = require("../games/sicbo/sicboEngine");
const { BET_CATALOG } = require("../games/sicbo/sicboConstants");

const TICK_MS = 500;
const TIMER_BROADCAST_MS = 1000; // throttle countdown broadcasts

let _nsp = null;
let _timer = null;
let _ticking = false;
/** Leader-local view of the active round + phase deadline. */
let _engine = { round: null, phaseDeadline: 0, settled: false };
let _lastTimerEmit = 0;
let _recovered = false;

function ROOM() {
  return "sicbo";
}
function userRoom(userId) {
  return `sicbo:user:${String(userId)}`;
}

function attach(nsp) {
  _nsp = nsp;
}

function broadcast(event, payload) {
  if (_nsp) _nsp.to(ROOM()).emit(event, payload);
}

function emitToUser(userId, event, payload) {
  if (_nsp) _nsp.to(userRoom(userId)).emit(event, payload);
}

/** Winning bet-type keys for a dice result (for client highlight). */
function winningBetTypes(dice) {
  const wins = [];
  for (const betType of BET_CATALOG.keys()) {
    if (evaluateBet(betType, dice).won) wins.push(betType);
  }
  return wins;
}

async function openNextRound() {
  const round = await roundManager.openRound({ bettingMs: BETTING_MS });
  _engine = { round, phaseDeadline: new Date(round.bettingEnd).getTime(), settled: false };
  const pub = roundManager.publicRound(round);
  await roundState.setStateCache(pub);
  broadcast("sicbo:new_round", pub);
  broadcast("sicbo:bet_open", { roundId: round.roundId, bettingEnd: round.bettingEnd });
  logger.info("sicbo_bet_open", { roundId: round.roundId });
}

async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    const isLeader = await roundState.acquireOrRenewLeadership();
    if (!isLeader) {
      _engine.round = null; // step down
      return;
    }

    // One-time recovery when this node first becomes leader.
    if (!_recovered) {
      _recovered = true;
      try {
        await roundManager.recoverStuckRounds();
      } catch (err) {
        logger.error("sicbo_boot_recovery_failed", { reason: err?.message });
      }
    }

    if (!_engine.round) {
      await openNextRound();
      return;
    }

    const now = Date.now();
    const round = _engine.round;

    switch (round.status) {
      case PHASE.BETTING: {
        // Throttled countdown broadcast.
        if (now - _lastTimerEmit >= TIMER_BROADCAST_MS) {
          _lastTimerEmit = now;
          broadcast("sicbo:timer", {
            roundId: round.roundId,
            msLeft: Math.max(0, _engine.phaseDeadline - now),
          });
        }
        if (now >= _engine.phaseDeadline) {
          const locked = await roundManager.lockRound(round.roundId);
          _engine.round = locked || (await refreshRound(round.roundId));
          broadcast("sicbo:bet_closed", { roundId: round.roundId });
        }
        break;
      }

      case PHASE.LOCKED: {
        // GENERATE RESULT → SAVE → reveal → SETTLE WALLET → broadcast → RESULT window.
        const resulted = await roundManager.rollAndResult(round.roundId);
        _engine.round = resulted;
        const dice = [resulted.dice1, resulted.dice2, resulted.dice3];

        broadcast("sicbo:dice_animation", {
          roundId: resulted.roundId,
          dice,
          serverSeed: resulted.serverSeed, // revealed now (betting closed)
          serverSeedHash: resulted.serverSeedHash,
          clientSeed: resulted.clientSeed,
          nonce: resulted.nonce,
        });
        broadcast("sicbo:result", {
          roundId: resulted.roundId,
          dice,
          total: resulted.total,
          result: {
            bigSmall: resulted.resultBigSmall,
            oddEven: resulted.resultOddEven,
            isTriple: resulted.isTriple,
          },
          winningBetTypes: winningBetTypes(dice),
        });

        // SETTLE WALLET (+ VERIFY COMPLETION inside settleRound). Personal payouts stream out.
        const { round: settled } = await roundManager.settleRound(resulted.roundId, {
          onUserSettled: (res) => {
            emitToUser(res.userId, "sicbo:payout", {
              roundId: resulted.roundId,
              payout: res.payout,
              wonBets: res.wonBets,
              totalBets: res.totalBets,
              balance: res.balance,
            });
          },
        });
        _engine.round = settled;
        _engine.settled = settled.status === PHASE.SETTLED;
        broadcast("sicbo:round_settled", {
          roundId: settled.roundId,
          totals: {
            totalBetAmount: settled.totalBetAmount,
            totalPayout: settled.totalPayout,
            totalPlayers: settled.totalPlayers,
          },
        });
        await roundState.setStateCache(roundManager.publicRound(settled));
        _engine.phaseDeadline = now + RESULT_MS;
        break;
      }

      case PHASE.RESULT:
      case PHASE.SETTLED: {
        // If settlement failed (round stuck in RESULT), retry before opening next.
        if (round.status === PHASE.RESULT && !_engine.settled) {
          const { round: retried } = await roundManager.settleRound(round.roundId);
          _engine.round = retried;
          _engine.settled = retried.status === PHASE.SETTLED;
        }
        if (now >= _engine.phaseDeadline) {
          await openNextRound();
        }
        break;
      }

      default:
        // Unknown state — reset and reopen next tick.
        _engine.round = null;
    }
  } catch (err) {
    logger.error("sicbo_engine_tick_failed", { reason: err?.message });
  } finally {
    _ticking = false;
  }
}

async function refreshRound(roundId) {
  const SicBoRound = require("../models/sicboRoundModel");
  return SicBoRound.findOne({ roundId });
}

function startSicboEngine({ nsp, redis } = {}) {
  if (redis) roundState.setRedisClient(redis);
  if (nsp) attach(nsp);
  if (_timer) return;
  _timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  if (typeof _timer.unref === "function") _timer.unref();
  logger.info("sicbo_engine_started", { tickMs: TICK_MS, bettingMs: BETTING_MS, resultMs: RESULT_MS });
}

function stopSicboEngine() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _engine = { round: null, phaseDeadline: 0, settled: false };
  _recovered = false;
  void roundState.releaseLeadership();
}

/** Current public round header (for late REST reads / new socket joins). */
async function getPublicStateForClient() {
  const cached = await roundState.getStateCache();
  if (cached) return cached;
  const SicBoRound = require("../models/sicboRoundModel");
  const round = await SicBoRound.findOne().sort({ createdAt: -1 });
  return roundManager.publicRound(round);
}

module.exports = {
  startSicboEngine,
  stopSicboEngine,
  attach,
  getPublicStateForClient,
  winningBetTypes,
  ROOM,
  userRoom,
  // test hooks
  _tickOnce: tick,
};
