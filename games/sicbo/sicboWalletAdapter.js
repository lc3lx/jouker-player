/**
 * Sic Bo wallet integration — reuses the existing casino wallet/ledger.
 *
 * Design guarantees:
 *   - Every bet is DEBITED and PERSISTED (SicBoBet) in ONE Mongo transaction at
 *     placement time. MongoDB is the financial source of truth — nothing financial
 *     lives only in memory/Redis.
 *   - Settlement is idempotent: it only touches bets with status "placed" and flips
 *     them to won/lost transactionally, so any replay/recovery is a no-op.
 *   - Per-user in-process mutex (withUserLock) serialises a user's bet/settle ops to
 *     prevent double-spend; the SicBoBet unique index + status guard prevent double
 *     payout across processes.
 *
 * Follows the games/goldenTree/goldenTreeWalletAdapter.js template (debit=game_loss,
 * credit=game_win) so Sic Bo shares the exact same economy as the slots.
 */
const {
  withMongoTransaction,
  getOrCreateWallet,
  ledgerWithdraw,
  ledgerDeposit,
} = require("../../services/walletLedgerService");
const SicBoBet = require("../../models/sicboBetModel");
const { evaluateBet } = require("./sicboEngine");
const { oddsFor, isAllowedStake, isValidBetType, MAX_ROUND_STAKE_PER_PLAYER } = require("./sicboConstants");

/** @type {Map<string, Promise<void>>} per-user serialization mutex. */
const userLocks = new Map();

async function withUserLock(userId, fn) {
  const key = String(userId);
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(key, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === gate) userLocks.delete(key);
  }
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/**
 * Place (or add to) a bet: validate → atomic debit + persist, all under the user lock.
 * Repeated bets on the same zone in the same round accumulate into one SicBoBet row.
 *
 * @returns {Promise<{ ok: true, betType, amount, totalOnZone, roundStake, balance }>}
 * @throws  Error with .code: INVALID_BET_TYPE | INVALID_STAKE | ROUND_LIMIT | INSUFFICIENT_BALANCE
 */
async function placeBet({ userId, roundId, betType, amount }) {
  const type = String(betType);
  const stake = toInt(amount);

  if (!isValidBetType(type)) {
    throw withCode(new Error("INVALID_BET_TYPE"), "INVALID_BET_TYPE");
  }
  if (!isAllowedStake(stake)) {
    throw withCode(new Error("INVALID_STAKE"), "INVALID_STAKE");
  }

  return withUserLock(userId, async () => {
    let result;
    await withMongoTransaction(async (session) => {
      // Re-check the betting window INSIDE the transaction so a bet cannot land
      // after the round locks (closes the read-then-debit race).
      const SicBoRound = require("../../models/sicboRoundModel");
      const round = await SicBoRound.findOne({ roundId }).session(session || null);
      if (!round) throw withCode(new Error("ROUND_NOT_FOUND"), "ROUND_NOT_FOUND");
      if (round.status !== "BETTING" || new Date(round.bettingEnd).getTime() <= Date.now()) {
        throw withCode(new Error("BETTING_CLOSED"), "BETTING_CLOSED");
      }

      // Enforce per-round total stake cap across ALL of this user's bets.
      const existingBets = await SicBoBet.find({ roundId, userId }).session(session || null);
      const currentRoundStake = existingBets.reduce((s, b) => s + toInt(b.amount), 0);
      if (currentRoundStake + stake > MAX_ROUND_STAKE_PER_PLAYER) {
        throw withCode(new Error("ROUND_LIMIT"), "ROUND_LIMIT");
      }

      // Atomic balance check + debit (throws INSUFFICIENT_BALANCE).
      const wallet = await getOrCreateWallet(userId, session);
      if (toInt(wallet.balance) < stake) {
        throw withCode(new Error("INSUFFICIENT_BALANCE"), "INSUFFICIENT_BALANCE");
      }
      await ledgerWithdraw({
        session,
        userId,
        amount: stake,
        ledgerType: "game_loss",
        meta: { source: "sicbo", roundId, betType: type, kind: "bet" },
      });

      // Persist / accumulate the bet in the SAME transaction (source of truth).
      const existing = existingBets.find((b) => b.betType === type);
      let totalOnZone;
      if (existing) {
        existing.amount = toInt(existing.amount) + stake;
        existing.odds = oddsFor(type);
        await existing.save({ session });
        totalOnZone = existing.amount;
      } else {
        await SicBoBet.create(
          [
            {
              userId,
              roundId,
              betType: type,
              amount: stake,
              odds: oddsFor(type),
              status: "placed",
            },
          ],
          session ? { session } : undefined
        );
        totalOnZone = stake;
      }

      const balance = toInt((await getOrCreateWallet(userId, session)).balance);
      result = {
        ok: true,
        betType: type,
        amount: stake,
        totalOnZone,
        roundStake: currentRoundStake + stake,
        balance,
      };
    });
    return result;
  });
}

/**
 * Settle all of a user's placed bets for a round against the dice result.
 * Idempotent: only "placed" bets are processed; re-runs credit nothing.
 *
 * @returns {Promise<{ userId, payout, wonBets, totalBets, balance, alreadySettled }>}
 */
async function settleUserBets({ userId, roundId, dice }) {
  return withUserLock(userId, async () => {
    let out = { userId: String(userId), payout: 0, wonBets: 0, totalBets: 0, alreadySettled: false, balance: null };
    await withMongoTransaction(async (session) => {
      const bets = await SicBoBet.find({ roundId, userId, status: "placed" }).session(session || null);
      if (bets.length === 0) {
        out.alreadySettled = true;
        const w = await getOrCreateWallet(userId, session);
        out.balance = toInt(w.balance);
        return;
      }

      let payout = 0;
      let wonBets = 0;
      for (const bet of bets) {
        const amount = toInt(bet.amount);
        const { won, multiplier } = evaluateBet(bet.betType, dice);
        const betPayout = won ? amount + Math.floor(amount * multiplier) : 0;
        bet.status = won ? "won" : "lost";
        bet.payout = betPayout;
        bet.settlementKey = `${roundId}:${userId}:${bet.betType}`;
        bet.settledAt = new Date();
        await bet.save({ session });
        if (won) {
          payout += betPayout;
          wonBets += 1;
        }
      }

      if (payout > 0) {
        await ledgerDeposit({
          session,
          userId,
          amount: payout,
          ledgerType: "game_win",
          meta: { source: "sicbo", roundId, kind: "settlement" },
        });
      }

      const w = await getOrCreateWallet(userId, session);
      out = {
        userId: String(userId),
        payout,
        wonBets,
        totalBets: bets.length,
        alreadySettled: false,
        balance: toInt(w.balance),
      };
    });
    return out;
  });
}

/**
 * Refund all placed bets for a round (used when a round is aborted before a result).
 * Idempotent via the "placed" status guard.
 */
async function refundUserBets({ userId, roundId }) {
  return withUserLock(userId, async () => {
    let refunded = 0;
    await withMongoTransaction(async (session) => {
      const bets = await SicBoBet.find({ roundId, userId, status: "placed" }).session(session || null);
      for (const bet of bets) {
        const amount = toInt(bet.amount);
        if (amount > 0) {
          await ledgerDeposit({
            session,
            userId,
            amount,
            ledgerType: "game_win",
            meta: { source: "sicbo", roundId, kind: "refund" },
          });
          refunded += amount;
        }
        bet.status = "refunded";
        bet.payout = amount;
        bet.settledAt = new Date();
        await bet.save({ session });
      }
    });
    return { userId: String(userId), refunded };
  });
}

async function getBalance(userId) {
  const wallet = await getOrCreateWallet(userId, null);
  return toInt(wallet.balance);
}

function withCode(err, code) {
  err.code = code;
  return err;
}

module.exports = {
  placeBet,
  settleUserBets,
  refundUserBets,
  getBalance,
  withUserLock,
};
