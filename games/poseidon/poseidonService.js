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
  appliedMultiplierFor,
  winTierFor,
  roundMoney,
} = require("./constants");
const spinEngine = require("./spinEngine");
const roundManager = require("./roundManager");
const wallet = require("./poseidonWalletAdapter");
const jackpotService = require("./jackpot/jackpotService");
const { settleJackpotRound } = require("./jackpot/jackpotSettlement");

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
async function executeSpin(userId, betAmountInput) {
  const userKey = String(userId);

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

  const superBonus = !!(isFreeSpin && bonusSession.superBonus);
  const spin = spinEngine.resolveSpin({ bonusMode: isFreeSpin, superBonus });

  // --- win math (bet multiples) ---
  // Plaques multiply the sequence win when it exists — per spin, in both
  // modes. Applied multiplier equals the face-value plaque sum (no soft-cap).
  // Losing spins ignore plaques for payout (they still count for the free-spins
  // trigger below). Overall win is still hard-capped by MAX_WIN_MULTIPLIER.
  const appliedMultiplier =
    spin.baseWin > 0 && spin.multiplierSum > 0
      ? appliedMultiplierFor(spin.multiplierSum, isFreeSpin)
      : 1;

  let totalWinX = spin.baseWin * appliedMultiplier;
  const winCapped = totalWinX > MAX_WIN_MULTIPLIER;
  if (winCapped) totalWinX = MAX_WIN_MULTIPLIER;

  const totalWin = roundMoney(totalWinX * betAmount);

  // --- free spins: 4+ base / 3+ during bonus (bought or natural) ---
  const multiplierCount = spin.multipliers.length;
  let freeSpinsTriggered = false;
  let freeSpinsAwarded = 0;
  if (isFreeSpin) {
    if (multiplierCount >= TRIGGER_RETRIGGER_MIN) {
      roundManager.addRetriggerSpins(userKey, RETRIGGER_AWARD);
      freeSpinsAwarded = RETRIGGER_AWARD;
    }
  } else if (
    multiplierCount >= TRIGGER_NATURAL_MIN &&
    !roundManager.hasActiveBonusSession(userKey)
  ) {
    roundManager.createBonusSession(userKey, {
      betAmount,
      freeSpins: FREE_SPINS_NATURAL,
    });
    await roundManager.touchSession(userKey);
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

  let bonusTotalWon = 0;
  if (isFreeSpin) {
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
  publishSpinCompleted(userKey, {
    sourceId: round.roundId,
    game: "poseidon",
    won: Number(totalWin || 0) > 0,
  });

  const liveSession = roundManager.getBonusSession(userKey);

  // --- jackpot round (server-authoritative) ---
  let jackpotGame = null;
  if (jackpotService.isJackpotTriggered(spin.finalMatrix)) {
    try {
      jackpotGame = await jackpotService.createJackpotRound({
        spinId: round.roundId,
        userId: userKey,
      });
    } catch (err) {
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
    appliedMultiplier,
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
}

/**
 * Buy bonus: pay the fixed cost and open a 10-free-spin session directly —
 * no forced trigger spin, the outcome is whatever the spins deal.
 */
async function executeBuyBonus(userId, currentBetInput, { superBonus = false } = {}) {
  const userKey = String(userId);
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
    sessionId: session.sessionId,
    betAmount: session.betAmount,
    freeSpinsRemaining: session.freeSpinsRemaining,
    bonusTotalWon: session.totalWon,
    superBonus: !!session.superBonus,
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
