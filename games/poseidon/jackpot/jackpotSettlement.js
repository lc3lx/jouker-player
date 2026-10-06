/**
 * jackpotSettlement — idempotent wallet credit for a Jackpot Round.
 *
 * Responsibilities:
 *   - Load the persisted round from DB (never trusts client amount)
 *   - Verify player ownership
 *   - Prevent double-settlement (returns existing result if already settled)
 *   - Credit wallet via the existing poseidonWalletAdapter (same atomic
 *     withMongoTransaction + ledgerDeposit path as normal spins)
 *   - Mark round as settled with a walletTransaction reference
 *
 * Idempotency contract:
 *   Calling settleJackpotRound(roundId, userId) twice is safe:
 *     first call  → credits wallet, marks settled, returns { settled, balance, prizeAmount }
 *     second call → no wallet operation, returns same shape { alreadySettled:true, balance, prizeAmount }
 */

const crypto = require("crypto");
const { JACKPOT_STATUS, JACKPOT_RETENTION_MS } = require("./jackpotConstants");

const MODE =
  process.env.POSEIDON_WALLET_MODE ||
  (process.env.NODE_ENV === "test" ? "stub" : "mongo");

// ─── round persistence (delegates to jackpotService internal helpers) ────────
// Re-use the same storage layer — no separate DB connection.
const jackpotService = require("./jackpotService");

async function _loadRound(roundId, session) {
  // Access internal stub directly in test mode for speed
  if (MODE !== "mongo") {
    return jackpotService._getStubRounds().get(roundId) ?? null;
  }
  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  const doc = await PoseidonJackpotRound.findOne({ roundId }).session(session || null);
  return doc ? doc.toObject() : null;
}

async function _markSettled(roundId, settlementId, session) {
  if (MODE !== "mongo") {
    const rounds = jackpotService._getStubRounds();
    const r = rounds.get(roundId);
    if (r) {
      const settledAt = new Date();
      rounds.set(roundId, {
        ...r,
        status: JACKPOT_STATUS.SETTLED,
        settlementId,
        settledAt,
        purgeAt: new Date(settledAt.getTime() + JACKPOT_RETENTION_MS),
      });
    }
    return;
  }
  const PoseidonJackpotRound = require("../../../models/poseidonJackpotRoundModel");
  await PoseidonJackpotRound.findOneAndUpdate(
    { roundId },
    { $set: { status: JACKPOT_STATUS.SETTLED, settlementId, settledAt: new Date(), purgeAt: new Date(Date.now() + JACKPOT_RETENTION_MS) } },
    { session }
  );
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Settle a Jackpot Round — credit the wallet and mark as settled.
 *
 * @param {string} roundId
 * @param {string} userId  — must match the stored userId
 * @returns {Promise<{settled:boolean, alreadySettled?:boolean, prizeAmount:number, balance:number}>}
 */
async function settleJackpotRound(roundId, userId) {
  const wallet = require("../poseidonWalletAdapter");
  return wallet.withUserLock(userId, async () => {
    if (MODE !== "mongo") return recordStats(await settleWithinTransaction(roundId, userId));
    const { withMongoTransaction } = require("../../../services/walletLedgerService");
    const result = await withMongoTransaction(async (session) => {
      // Never commit the prize and round marker separately.
      if (!session) throw new Error("JACKPOT_REQUIRES_MONGO_TRANSACTION");
      return settleWithinTransaction(roundId, userId, session);
    });
    return recordStats({ ...result, balance: await wallet.getBalance(userId) });
  });
}

const STATS_GAME = { "king-arth": "zeus", poseidon: "poseidon", zenobia: "zenobia" };

/** Economy telemetry for a first-time settlement of a profile-game round. */
function recordStats(result) {
  const ctx = result._stats;
  delete result._stats;
  if (ctx && !result.alreadySettled && STATS_GAME[ctx.game] && result.prizeAmount > 0) {
    require("../../utils/slotEconomyStats").recordJackpotPaid({
      game: STATS_GAME[ctx.game],
      profileId: ctx.profileId,
      economyVersion: ctx.economyVersion,
      origin: ctx.origin,
      amount: result.prizeAmount,
    });
  }
  return result;
}

async function settleWithinTransaction(roundId, userId, session) {
  const round = await _loadRound(roundId, session);

  // ── validation ────────────────────────────────────────────────────────────
  if (!round) {
    const ApiError = require("../../../utils/apiError");
    throw new ApiError(`Jackpot round not found: ${roundId}`, 404);
  }
  if (round.userId !== String(userId)) {
    const ApiError = require("../../../utils/apiError");
    throw new ApiError("Jackpot round belongs to a different player", 403);
  }
  if (round.status === JACKPOT_STATUS.EXPIRED) {
    const ApiError = require("../../../utils/apiError");
    throw new ApiError("Jackpot round has expired", 410);
  }

  // ── idempotency guard ─────────────────────────────────────────────────────
  if (round.status === JACKPOT_STATUS.SETTLED) {
    const wallet = round.game === "zenobia" ? require("../../zenobia/zenobiaWalletAdapter") : require("../poseidonWalletAdapter");
    const balance = session ? 0 : await wallet.getBalance(userId);
    return {
      settled: true,
      alreadySettled: true,
      roundId,
      prizeType: round.prizeType,
      prizeAmount: round.prizeAmount,
      balance,
    };
  }

  if (round.status !== JACKPOT_STATUS.REVEALED || round.prizeType === "pending") {
    const ApiError = require("../../../utils/apiError");
    throw new ApiError("Jackpot round is not ready to settle — reveal cards first", 409);
  }

  // ── credit wallet (prize=0 is a no-op in creditBalance) ───────────────────
  const wallet = require("../poseidonWalletAdapter");
  const prizeAmount = round.prizeAmount; // loaded from DB — never from client

  let balanceAfter;
  const settlementId = crypto.randomUUID();

  if (prizeAmount > 0) {
    const source =
      round.game === "king-arth"
        ? "king_arth_jackpot"
        : round.game === "golden-tree"
          ? "golden_tree_jackpot"
          : round.game === "zenobia"
            ? "zenobia_jackpot"
            : "poseidon_jackpot";
    const walletMod =
      round.game === "zenobia"
        ? require("../../zenobia/zenobiaWalletAdapter")
        : wallet;
    const meta = { source, roundId, settlementId, prizeType: round.prizeType };
    if (session) {
      const { ledgerDeposit } = require("../../../services/walletLedgerService");
      await ledgerDeposit({ session, userId, amount: prizeAmount, ledgerType: "game_win", meta });
      balanceAfter = 0; // Read committed balance after the transaction.
    } else {
      const result = await walletMod.creditBalance(userId, prizeAmount, meta);
      balanceAfter = result.balance;
    }
  } else {
    balanceAfter = await wallet.getBalance(userId);
  }

  await _markSettled(roundId, settlementId, session);

  return {
    settled: true,
    roundId,
    prizeType: round.prizeType,
    prizeAmount,
    balance: balanceAfter,
    _stats: { game: round.game, profileId: round.profileId, economyVersion: round.economyVersion, origin: round.origin },
  };
}

module.exports = { settleJackpotRound };
