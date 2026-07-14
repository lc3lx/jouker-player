/**
 * Sic Bo round lifecycle — authoritative state machine backed by MongoDB.
 *
 * Phase order (server-authoritative):
 *   BETTING → LOCKED → ROLLING → RESULT → (settle wallet) → VERIFY COMPLETION → SETTLED
 *
 * The provably-fair dice are fixed the moment a round OPENS (derived from the secret
 * serverSeed whose hash is published immediately); they are only revealed at RESULT,
 * after betting closes. Every bet is already persisted (SicBoBet) by the wallet adapter,
 * so settlement and recovery read the financial truth from Mongo, never from memory.
 */
const crypto = require("crypto");
const logger = require("../../utils/logger");
const SicBoRound = require("../../models/sicboRoundModel");
const SicBoBet = require("../../models/sicboBetModel");
const { rollDice, summarize } = require("./sicboEngine");
const { createRoundCommitment } = require("./sicboSeed");
const walletAdapter = require("./sicboWalletAdapter");
const rtp = require("./sicboRtp");
const { PHASE } = require("./sicboConstants");

function newRoundId() {
  return `sb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Create a fresh round in BETTING with a published seed commitment.
 * `bettingEnd` = when betting closes; `resultAt` = when winners are revealed
 * (= bettingEnd + rollMs). The dice shake fills the [bettingEnd, resultAt] window.
 */
async function openRound({ bettingMs, rollMs = 0 }) {
  const roundId = newRoundId();
  const commitment = createRoundCommitment(roundId);
  const now = new Date();
  const bettingEnd = new Date(now.getTime() + bettingMs);
  const round = await SicBoRound.create({
    roundId,
    status: PHASE.BETTING,
    bettingStart: now,
    bettingEnd,
    resultAt: new Date(bettingEnd.getTime() + rollMs),
    serverSeedHash: commitment.serverSeedHash,
    clientSeed: commitment.clientSeed,
    nonce: commitment.nonce,
    // serverSeed is stored but withheld from clients until RESULT.
    serverSeed: commitment.serverSeed,
  });
  logger.info("sicbo_round_open", { roundId, bettingEnd, resultAt: round.resultAt });
  return round;
}

/** Close betting: BETTING → LOCKED. */
async function lockRound(roundId) {
  return SicBoRound.findOneAndUpdate(
    { roundId, status: PHASE.BETTING },
    { $set: { status: PHASE.LOCKED } },
    { new: true }
  );
}

/**
 * Roll + persist the result: LOCKED → ROLLING → RESULT.
 * Dice are deterministic from the committed seeds (provably fair).
 */
async function rollAndResult(roundId) {
  const round = await SicBoRound.findOne({ roundId });
  if (!round) throw new Error("ROUND_NOT_FOUND");
  if (round.status === PHASE.SETTLED || round.status === PHASE.RESULT) return round;

  const dice = rollDice(round.serverSeed, round.clientSeed, round.nonce);
  const s = summarize(dice);

  round.status = PHASE.RESULT;
  round.dice1 = dice[0];
  round.dice2 = dice[1];
  round.dice3 = dice[2];
  round.total = s.total;
  round.isTriple = s.isTriple;
  round.resultBigSmall = s.bigSmall;
  round.resultOddEven = s.oddEven;
  round.rolledAt = new Date();
  await round.save();
  logger.info("sicbo_round_result", { roundId, dice, total: s.total });
  return round;
}

/**
 * SETTLE WALLET + VERIFY COMPLETION: pay every user's placed bets, then mark SETTLED.
 * Idempotent — settles only "placed" bets, so re-runs (recovery) are safe.
 * @returns {Promise<{ round, totals, payouts }>}
 */
async function settleRound(roundId, { onUserSettled } = {}) {
  const round = await SicBoRound.findOne({ roundId });
  if (!round) throw new Error("ROUND_NOT_FOUND");
  if (round.status === PHASE.SETTLED) {
    return { round, totals: roundTotals(round), payouts: [], alreadySettled: true };
  }
  if (round.dice1 == null) {
    // No result yet — cannot settle. Caller should roll first.
    throw new Error("ROUND_HAS_NO_RESULT");
  }

  const dice = [round.dice1, round.dice2, round.dice3];
  const userIds = await SicBoBet.distinct("userId", { roundId, status: "placed" });
  round.expectedSettlements = userIds.length;
  await round.save();

  const payouts = [];
  let failures = 0;
  let settledCount = 0;
  for (const userId of userIds) {
    try {
      const res = await walletAdapter.settleUserBets({ userId, roundId, dice });
      settledCount += 1;
      payouts.push(res);
      if (typeof onUserSettled === "function") {
        try {
          onUserSettled(res);
        } catch (_) {
          /* broadcast errors must not abort settlement */
        }
      }
    } catch (err) {
      failures += 1;
      logger.error("sicbo_user_settlement_failed", {
        roundId,
        userId: String(userId),
        reason: err?.message,
      });
    }
  }

  // Aggregate financial totals from the persisted bets (source of truth).
  const agg = await SicBoBet.aggregate([
    { $match: { roundId } },
    {
      $group: {
        _id: null,
        totalBetAmount: { $sum: "$amount" },
        totalPayout: { $sum: "$payout" },
        totalBets: { $sum: 1 },
        players: { $addToSet: "$userId" },
      },
    },
  ]);
  const a = agg[0] || { totalBetAmount: 0, totalPayout: 0, totalBets: 0, players: [] };

  round.settledCount = settledCount;
  round.totalBetAmount = a.totalBetAmount;
  round.totalPayout = a.totalPayout;
  round.totalBets = a.totalBets;
  round.totalPlayers = Array.isArray(a.players) ? a.players.length : 0;
  round.houseProfit = a.totalBetAmount - a.totalPayout;

  if (failures === 0) {
    round.status = PHASE.SETTLED;
    round.settledAt = new Date();
    round.settlementError = undefined;
  } else {
    // Leave in RESULT so the watchdog re-runs settleRound (idempotent).
    round.settlementError = `${failures} user settlement(s) failed`;
  }
  await round.save();

  if (failures === 0) {
    // Fold into RTP stats once, only on full completion.
    rtp.recordRound({ totalBetAmount: round.totalBetAmount, totalPayout: round.totalPayout }).catch(
      (err) => logger.warn("sicbo_rtp_record_failed", { roundId, reason: err?.message })
    );
  }

  return { round, totals: roundTotals(round), payouts, failures };
}

/** Abort a round before a result and refund all placed bets. */
async function abortAndRefund(roundId, reason = "aborted") {
  const round = await SicBoRound.findOne({ roundId });
  if (!round || round.status === PHASE.SETTLED) return { refunded: 0 };
  const userIds = await SicBoBet.distinct("userId", { roundId, status: "placed" });
  let refunded = 0;
  for (const userId of userIds) {
    try {
      const r = await walletAdapter.refundUserBets({ userId, roundId });
      refunded += r.refunded;
    } catch (err) {
      logger.error("sicbo_refund_failed", { roundId, userId: String(userId), reason: err?.message });
    }
  }
  round.status = PHASE.SETTLED;
  round.settledAt = new Date();
  round.settlementError = `refunded:${reason}`;
  await round.save();
  logger.warn("sicbo_round_aborted", { roundId, reason, refunded });
  return { refunded };
}

/**
 * Boot / watchdog recovery: finish any round left un-SETTLED after a crash.
 * - Rounds with a result → re-run settleRound (idempotent).
 * - Rounds without a result but past their betting window → roll then settle.
 * - Very old BETTING rounds with no result and no engine → refund.
 */
async function recoverStuckRounds({ maxAgeMs = 5 * 60 * 1000 } = {}) {
  const stuck = await SicBoRound.find({
    status: { $in: [PHASE.BETTING, PHASE.LOCKED, PHASE.ROLLING, PHASE.RESULT] },
  })
    .sort({ createdAt: 1 })
    .limit(200);

  const summaryList = [];
  for (const round of stuck) {
    try {
      if (round.dice1 != null) {
        const { round: settled } = await settleRound(round.roundId);
        summaryList.push({ roundId: round.roundId, action: "settled", status: settled.status });
        continue;
      }
      const age = Date.now() - new Date(round.bettingEnd || round.createdAt).getTime();
      if (age >= 0 || age < maxAgeMs) {
        // Betting window elapsed (or crashed mid-flight) → produce the committed result and settle.
        await rollAndResult(round.roundId);
        const { round: settled } = await settleRound(round.roundId);
        summaryList.push({ roundId: round.roundId, action: "rolled_settled", status: settled.status });
      } else {
        await abortAndRefund(round.roundId, "recovery_no_result");
        summaryList.push({ roundId: round.roundId, action: "refunded" });
      }
    } catch (err) {
      logger.error("sicbo_recovery_failed", { roundId: round.roundId, reason: err?.message });
      summaryList.push({ roundId: round.roundId, action: "error", reason: err?.message });
    }
  }
  if (summaryList.length) logger.info("sicbo_recovery_complete", { count: summaryList.length });
  return summaryList;
}

function roundTotals(round) {
  return {
    totalBetAmount: round.totalBetAmount || 0,
    totalPayout: round.totalPayout || 0,
    houseProfit: round.houseProfit || 0,
    totalPlayers: round.totalPlayers || 0,
    totalBets: round.totalBets || 0,
  };
}

/** Public round header for clients — serverSeed only revealed once at/after RESULT. */
function publicRound(round) {
  if (!round) return null;
  const revealed = round.status === PHASE.RESULT || round.status === PHASE.SETTLED;
  return {
    roundId: round.roundId,
    status: round.status,
    bettingStart: round.bettingStart,
    bettingEnd: round.bettingEnd,
    resultAt: round.resultAt,
    serverSeedHash: round.serverSeedHash,
    clientSeed: round.clientSeed,
    nonce: round.nonce,
    serverSeed: revealed ? round.serverSeed : undefined,
    dice: revealed && round.dice1 != null ? [round.dice1, round.dice2, round.dice3] : undefined,
    total: revealed ? round.total : undefined,
    result: revealed
      ? { bigSmall: round.resultBigSmall, oddEven: round.resultOddEven, isTriple: round.isTriple }
      : undefined,
    totals: {
      totalBetAmount: round.totalBetAmount || 0,
      totalPayout: round.totalPayout || 0,
      totalPlayers: round.totalPlayers || 0,
    },
  };
}

/** The single active BETTING round (any node reads this from Mongo), or null. */
async function getCurrentBettingRound() {
  return SicBoRound.findOne({ status: PHASE.BETTING }).sort({ createdAt: -1 });
}

/** Latest round of any status (for late joins / REST reads). */
async function getLatestRound() {
  return SicBoRound.findOne().sort({ createdAt: -1 });
}

/** A user's own placed bets for a round (reconnect snapshot). */
async function getUserBets(roundId, userId) {
  const bets = await SicBoBet.find({ roundId, userId }).lean();
  return bets.map((b) => ({
    betType: b.betType,
    amount: b.amount,
    odds: b.odds,
    status: b.status,
    payout: b.payout,
  }));
}

module.exports = {
  newRoundId,
  openRound,
  lockRound,
  rollAndResult,
  settleRound,
  abortAndRefund,
  recoverStuckRounds,
  publicRound,
  getUserBets,
  getCurrentBettingRound,
  getLatestRound,
};
