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
const { PHASE, BETTING_MS, ROLL_MS, RESULT_MS } = require("../games/sicbo/sicboConstants");
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
  const round = await roundManager.openRound({ bettingMs: BETTING_MS, rollMs: ROLL_MS });
  const rollAt = new Date(round.bettingEnd).getTime(); // betting closes → shake
  const resultAt = new Date(round.resultAt).getTime(); // winners revealed
  _engine = { round, rollAt, resultAt, nextAt: resultAt + RESULT_MS, rolled: false, settled: false };
  const pub = roundManager.publicRound(round);
  await roundState.setStateCache(pub);
  broadcast("sicbo:new_round", pub);
  broadcast("sicbo:bet_open", {
    roundId: round.roundId,
    bettingEnd: round.bettingEnd,
    resultAt: round.resultAt,
  });
  logger.info("sicbo_bet_open", { roundId: round.roundId });
}

function emitTimer(e, now) {
  if (now - _lastTimerEmit >= TIMER_BROADCAST_MS) {
    _lastTimerEmit = now;
    broadcast("sicbo:timer", {
      roundId: e.round.roundId,
      msLeft: Math.max(0, e.resultAt - now), // countdown always targets the RESULT
    });
  }
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
    const e = _engine;

    // ── BETTING: countdown to result; at betting close, roll + start the shake ──
    if (!e.rolled) {
      emitTimer(e, now);
      if (now >= e.rollAt) {
        await roundManager.lockRound(e.round.roundId);
        const resulted = await roundManager.rollAndResult(e.round.roundId);
        e.round = resulted;
        e.rolled = true;
        const dice = [resulted.dice1, resulted.dice2, resulted.dice3];
        broadcast("sicbo:bet_closed", { roundId: resulted.roundId });
        // Dice sent now (betting is closed); the client cup shakes for ROLL_MS and
        // settles ~1s before the result. Winners are NOT revealed until resultAt.
        broadcast("sicbo:dice_animation", {
          roundId: resulted.roundId,
          dice,
          serverSeed: resulted.serverSeed,
          serverSeedHash: resulted.serverSeedHash,
          clientSeed: resulted.clientSeed,
          nonce: resulted.nonce,
          resultAt: resulted.resultAt,
        });
        await roundState.setStateCache(roundManager.publicRound(resulted));
      }
      return;
    }

    // ── ROLLING: keep the countdown ticking; at resultAt reveal winners + settle ──
    if (!e.settled) {
      emitTimer(e, now);
      if (now >= e.resultAt) {
        const dice = [e.round.dice1, e.round.dice2, e.round.dice3];
        broadcast("sicbo:result", {
          roundId: e.round.roundId,
          dice,
          total: e.round.total,
          result: {
            bigSmall: e.round.resultBigSmall,
            oddEven: e.round.resultOddEven,
            isTriple: e.round.isTriple,
          },
          winningBetTypes: winningBetTypes(dice),
        });
        const { round: settled } = await roundManager.settleRound(e.round.roundId, {
          onUserSettled: (res) => {
            emitToUser(res.userId, "sicbo:payout", {
              roundId: e.round.roundId,
              payout: res.payout,
              wonBets: res.wonBets,
              totalBets: res.totalBets,
              balance: res.balance,
            });
          },
        });
        e.round = settled;
        e.settled = settled.status === PHASE.SETTLED;
        broadcast("sicbo:round_settled", {
          roundId: settled.roundId,
          totals: {
            totalBetAmount: settled.totalBetAmount,
            totalPayout: settled.totalPayout,
            totalPlayers: settled.totalPlayers,
          },
        });
        await roundState.setStateCache(roundManager.publicRound(settled));
      }
      return;
    }

    // ── POST-RESULT gap → next round ──
    if (now >= e.nextAt) {
      await openNextRound();
    }
  } catch (err) {
    logger.error("sicbo_engine_tick_failed", { reason: err?.message });
  } finally {
    _ticking = false;
  }
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
