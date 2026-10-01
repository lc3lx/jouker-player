const slotOperation = require("../utils/slotOperation");
const ApiError = require("../../utils/apiError");
const {
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  RETRIGGER_AWARD,
  TRIGGER_NATURAL_MIN,
  TRIGGER_RETRIGGER_MIN,
  resolvePayoutMultiplier,
  BONUS_BANK_CAP,
  SUPER_BONUS_BANK_CAP,
  winTierFor,
  roundMoney,
} = require("./constants");
const spinEngine = require("./spinEngine");
const roundManager = require("./roundManager");
const wallet = require("./poseidonWalletAdapter");
const jackpotService = require("./jackpot/jackpotService");
const { settleJackpotRound } = require("./jackpot/jackpotSettlement");
const houseEdgeController = require("../utils/houseEdgeController");

function mapWalletError(err) {
  if (
    err?.code === "INSUFFICIENT_BALANCE" ||
    err?.message === "INSUFFICIENT_BALANCE"
  ) {
    throw new ApiError("Insufficient wallet balance", 402);
  }
  throw err;
}

function validateBet(betAmount) {
  const bet = roundMoney(betAmount);
  if (!Number.isFinite(bet) || bet < BET_MIN || bet > BET_MAX) {
    throw new ApiError(`Bet must be between ${BET_MIN} and ${BET_MAX} coins`, 400);
  }
  return bet;
}

/** Attach coin amounts to engine steps (engine works in bet multiples). */
/** Attach coin amounts to engine steps (engine works in bet multiples). */
function stepsWithAmounts(steps, betAmount) {
  return steps.map((step) => ({
    ...step,
    stepWinAmount: roundMoney(step.stepWin * betAmount),
    wins: step.wins.map((w) => ({
      ...w,
      payoutAmount: roundMoney(w.payout * betAmount),
    })),
  }));
}

/** Execute one round (paid spin or free spin from an active session). */
async function executeSpinInternal(userId, betAmountInput) {
  const userKey = String(userId);

  return wallet.withUserLock(userKey, async () => {
    await roundManager.ensureLoaded(userKey);
    const bonusSession = roundManager.getBonusSession(userKey);
    const isFreeSpin =
      bonusSession != null && bonusSession.freeSpinsRemaining > 0;

    const betAmount = isFreeSpin
      ? bonusSession.betAmount
      : validateBet(betAmountInput);

    if (!isFreeSpin) {
      const balance = await wallet.getBalance(userKey);
      if (balance < betAmount) {
        throw new ApiError("Insufficient wallet balance", 402);
      }
    }

    const economyVersion = isFreeSpin ? (bonusSession.economyVersion || 1) : 2;
    const superBonus = !!(isFreeSpin && bonusSession.superBonus);
    const edgeParams = economyVersion === 2 && isFreeSpin ? null : houseEdgeController.calculateEdge({
      game: "poseidon",
      betAmount,
      betMin: BET_MIN,
      userId: userKey,
      isBonusSpin: isFreeSpin,
      economyVersion,
    });
    const spin = spinEngine.resolveSpin({
      bonusMode: isFreeSpin,
      superBonus,
      edgeParams,
      economyVersion,
    });

    // --- win math (bet multiples) ---
    // Base: this spin's plaques multiply a winning sequence. Bonus: plaques from
    // winning spins bank into a session total activated only by fresh plaques.
    // Losing spins ignore plaques for payout (they still count for the free-spins
    // trigger below). Overall win is still hard-capped by MAX_WIN_MULTIPLIER.
    const carried = isFreeSpin ? Number(bonusSession.bonusMultiplier || 0) : 0;
    const freshPlaques = Math.max(0, Number(spin.multiplierSum) || 0);
    const resolveMultiplier = economyVersion === 1 ? require("./constants.v1").resolvePayoutMultiplier : resolvePayoutMultiplier;
    const { applied: appliedMultiplier, nextCarried } = resolveMultiplier({
      baseWin: spin.baseWin,
      plaqueSum: freshPlaques,
      carried,
      isFreeSpin,
      bankCap: superBonus ? SUPER_BONUS_BANK_CAP : BONUS_BANK_CAP,
    });

    // Pay the displayed multiplier in full. Only the published maximum applies;
    // bet-tier compression would make baseWin * appliedMultiplier disagree
    // with both the credited amount and the bonus bank shown to the player.
    const activeCapMultiplier = MAX_WIN_MULTIPLIER;
    let totalWinX = spin.baseWin * appliedMultiplier;
    const winCapped = totalWinX > activeCapMultiplier;
    if (winCapped) totalWinX = activeCapMultiplier;

    const totalWin = roundMoney(totalWinX * betAmount);

    // --- free spins: 4 heads in base / 3 heads during bonus ---
    const multiplierCount = spin.multipliers.length;
    const scatterCount = Number.isFinite(spin.scatterCount)
      ? spin.scatterCount
      : (spin.scatters || []).length;
    let freeSpinsTriggered = false;
    let freeSpinsAwarded = 0;
    let stagedBonusAction = null;
    if (isFreeSpin) {
      if (scatterCount >= TRIGGER_RETRIGGER_MIN) {
        stagedBonusAction = { type: "retrigger", spins: RETRIGGER_AWARD };
        freeSpinsAwarded = RETRIGGER_AWARD;
      }
    } else if (
      scatterCount >= TRIGGER_NATURAL_MIN &&
      !roundManager.hasActiveBonusSession(userKey)
    ) {
      stagedBonusAction = {
        type: "create",
        betAmount,
        freeSpins: FREE_SPINS_NATURAL,
      };
      freeSpinsTriggered = true;
      freeSpinsAwarded = FREE_SPINS_NATURAL;
    }

    // --- settlement ---
    let balanceAfter;
    try {
      balanceAfter = await wallet.atomicSpinWallet(userKey, {
        betAmount: isFreeSpin ? 0 : betAmount,
        winAmount: totalWin,
        meta: { type: isFreeSpin ? "free_spin" : "main_spin" },
      });
    } catch (err) {
      mapWalletError(err);
    }

    // Apply staged bonus session ONLY after successful debit/settlement
    if (stagedBonusAction) {
      if (stagedBonusAction.type === "retrigger") {
        roundManager.addRetriggerSpins(userKey, stagedBonusAction.spins);
      } else if (stagedBonusAction.type === "create") {
        roundManager.createBonusSession(userKey, {
          betAmount: stagedBonusAction.betAmount,
          freeSpins: stagedBonusAction.freeSpins,
        });
        await roundManager.touchSession(userKey);
      }
    }

    let bonusTotalWon = 0;
    if (isFreeSpin) {
      // A rejected wallet settlement must not bank this spin's plaques.
      roundManager.setBonusMultiplier(userKey, nextCarried);
      roundManager.addBonusWin(userKey, totalWin);
      bonusTotalWon = roundManager.getBonusSession(userKey)?.totalWon ?? 0;
      roundManager.consumeBonusSpin(userKey);
    }

    const round = roundManager.createRound({
      userId: userKey,
      betAmount,
      initialMatrix: spin.initialMatrix,
      steps: spin.steps,
      totalWin,
      isFreeSpin,
      bonusSessionId: bonusSession?.sessionId || null,
    });

    const { publishSpinCompleted } = require("../../domain/publishers/playerActivityPublishers");
    slotOperation.afterCommit(() => publishSpinCompleted(userKey, {
      sourceId: round.roundId,
      game: "poseidon",
      won: Number(totalWin || 0) > 0,
    }));
    slotOperation.afterCommit(() => houseEdgeController.recordSpin(userKey, "poseidon", isFreeSpin ? 0 : betAmount, totalWin));

    const liveSession = roundManager.getBonusSession(userKey);

    // --- jackpot round (server-authoritative) ---
    let jackpotGame = null;
    if (jackpotService.isJackpotTriggered(spin.finalMatrix)) {
      try {
        jackpotGame = await jackpotService.createJackpotRound({
          spinId: round.roundId,
          betAmount,
          userId: userKey,
        });
      } catch (err) {
        if (slotOperation.active()) throw err;
        // Non-fatal — log and continue without jackpot data rather than
        // failing the whole spin. The round still settles normally.
        const logger = (() => { try { return require("../../utils/logger"); } catch { return console; } })();
        logger.error?.("jackpot round creation failed", { err: err?.message, userId: userKey });
      }
    }

    return {
      roundId: round.roundId,
      roundHash: round.roundHash,
      betAmount,
      initialMatrix: spin.initialMatrix,
      steps: stepsWithAmounts(spin.steps, betAmount),
      finalMatrix: spin.finalMatrix,
      multipliers: spin.multipliers,
      multiplierSum: spin.multiplierSum,
      multiplierCount,
      scatterCount,
      appliedMultiplier,
      bonusMultiplier: isFreeSpin ? nextCarried : 0,
      baseWinAmount: roundMoney(spin.baseWin * betAmount),
      totalWin,
      winCapped,
      maxWinCap: roundMoney(MAX_WIN_MULTIPLIER * betAmount),
      winTier: winTierFor(totalWinX),
      isFreeSpin,
      freeSpinsTriggered,
      freeSpinsAwarded,
      freeSpinsRemaining: liveSession?.freeSpinsRemaining ?? 0,
      bonusTotalWon: isFreeSpin ? bonusTotalWon : 0,
      balance: roundMoney(balanceAfter),
      jackpotGame,        // null when no jackpot triggered; JackpotGameData otherwise
    };
  });
}

/**
 * Buy bonus: pay the fixed cost and open a 10-free-spin session directly —
 * no forced trigger spin, the outcome is whatever the spins deal.
 */
async function executeBuyBonusInternal(userId, currentBetInput, { superBonus = false } = {}) {
  const userKey = String(userId);
  return wallet.withUserLock(userKey, async () => {
    await roundManager.ensureLoaded(userKey);
    if (roundManager.hasActiveBonusSession(userKey)) {
      throw new ApiError("Bonus session already active", 409);
    }

    const betAmount = validateBet(currentBetInput);
    const multiplier = superBonus ? SUPER_BUY_BONUS_COST : BUY_BONUS_COST;
    const cost = roundMoney(betAmount * multiplier);

    const balance = await wallet.getBalance(userKey);
    if (balance < cost) {
      throw new ApiError("Insufficient wallet balance for bonus purchase", 402);
    }

    try {
      await wallet.deductBalance(userKey, cost, { leg: "buy_bonus" });
    } catch (err) {
      mapWalletError(err);
    }

    const session = roundManager.createBonusSession(userKey, {
      betAmount,
      freeSpins: FREE_SPINS_BOUGHT,
      superBonus: !!superBonus,
    });
    await roundManager.touchSession(userKey);

    slotOperation.afterCommit(() => houseEdgeController.recordSpin(String(userId), "poseidon", cost, 0));
    const balanceAfter = await wallet.getBalance(userKey);

    return {
      sessionId: session.sessionId,
      cost,
      betAmount,
      superBonus: !!superBonus,
      freeSpinsTriggered: true,
      freeSpinsAwarded: FREE_SPINS_BOUGHT,
      freeSpinsRemaining: session.freeSpinsRemaining,
      balance: roundMoney(balanceAfter),
    };
  });
}

/** Active free-spins / buy-bonus session for reconnect restore. */
async function getActiveSession(userId) {
  const userKey = String(userId);
  await roundManager.ensureLoaded(userKey);
  const session = roundManager.getBonusSession(userKey);
  if (!session || session.freeSpinsRemaining <= 0) {
    return { active: false };
  }
  return {
    active: true,
    economyVersion: session.economyVersion || 1,
    sessionId: session.sessionId,
    betAmount: session.betAmount,
    freeSpinsRemaining: session.freeSpinsRemaining,
    bonusTotalWon: session.totalWon,
    superBonus: !!session.superBonus,
    bonusMultiplier: Number(session.bonusMultiplier || 0),
  };
}

/**
 * Settle a Jackpot Round after the scratch-card sequence is complete.
 * Idempotent — safe to call on retry / reconnect.
 */
async function executeJackpotSettle(userId, roundId) {
  if (!roundId || typeof roundId !== "string") {
    throw new ApiError("roundId is required", 400);
  }
  return settleJackpotRound(roundId, String(userId));
}

/**
 * Recover an in-progress Jackpot Round (reconnect / crash).
 * Returns null when no active round exists for this player+roundId.
 */
async function recoverJackpot(userId, roundId) {
  if (!roundId || typeof roundId !== "string") {
    throw new ApiError("roundId is required", 400);
  }
  const data = await jackpotService.recoverJackpotRound(roundId, String(userId));
  return data;
}

/**
 * Reveal one scratch card (server validates + returns the face).
 */
async function executeJackpotReveal(userId, roundId, cardIndex) {
  if (!roundId || typeof roundId !== "string") {
    throw new ApiError("roundId is required", 400);
  }
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx > 8) {
    throw new ApiError("cardIndex must be 0..8", 400);
  }
  try {
    return await jackpotService.revealJackpotCard(roundId, String(userId), idx);
  } catch (err) {
    if (err.message?.includes("not found")) {
      throw new ApiError(err.message, 404);
    }
    if (err.message?.includes("mismatch")) {
      throw new ApiError(err.message, 403);
    }
    throw err;
  }
}

module.exports = {
  executeSpin,
  executeBuyBonus,
  getActiveSession,
  validateBet,
  executeJackpotSettle,
  recoverJackpot,
  executeJackpotReveal,
  // Back-compat for older controllers that still call markJackpotRevealed
  markJackpotRevealed: executeJackpotReveal,
};

function executeSpin(userId, betAmount, options = {}) {
  return slotOperation.run({ game: "poseidon", userId, wallet, manager: roundManager, modelName: "poseidonBonusSessionModel", requestId: options.requestId, input: ["spin", betAmount] }, () => executeSpinInternal(userId, betAmount));
}
function executeBuyBonus(userId, currentBet, options = {}) {
  return slotOperation.run({ game: "poseidon", userId, wallet, manager: roundManager, modelName: "poseidonBonusSessionModel", requestId: options.requestId, input: ["buy", currentBet, !!options.superBonus] }, () => executeBuyBonusInternal(userId, currentBet, options));
}
