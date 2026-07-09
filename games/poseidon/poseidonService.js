const ApiError = require("../../utils/apiError");
const {
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  BUY_BONUS_COST,
  FREE_SPINS_NATURAL,
  FREE_SPINS_BOUGHT,
  RETRIGGER_AWARD,
  TRIGGER_MIN_MULTIPLIERS,
  winTierFor,
  roundMoney,
} = require("./constants");
const { resolveSpin } = require("./spinEngine");
const roundManager = require("./roundManager");
const wallet = require("./poseidonWalletAdapter");

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

  const spin = resolveSpin({ bonusMode: isFreeSpin });

  // --- win math (bet multiples) ---
  // Plaques multiply the sequence win when it exists — per spin, in both
  // modes. Plaques on a losing spin do nothing (they still count for the
  // free-spins trigger below).
  const appliedMultiplier =
    spin.baseWin > 0 && spin.multiplierSum > 0 ? spin.multiplierSum : 1;

  let totalWinX = spin.baseWin * appliedMultiplier;
  const winCapped = totalWinX > MAX_WIN_MULTIPLIER;
  if (winCapped) totalWinX = MAX_WIN_MULTIPLIER;

  const totalWin = roundMoney(totalWinX * betAmount);

  // --- free spins trigger / retrigger (3+ plaques on the final screen) ---
  const multiplierCount = spin.multipliers.length;
  let freeSpinsTriggered = false;
  let freeSpinsAwarded = 0;
  if (isFreeSpin) {
    if (multiplierCount >= TRIGGER_MIN_MULTIPLIERS) {
      roundManager.addRetriggerSpins(userKey, RETRIGGER_AWARD);
      freeSpinsAwarded = RETRIGGER_AWARD;
    }
  } else if (
    multiplierCount >= TRIGGER_MIN_MULTIPLIERS &&
    !roundManager.hasActiveBonusSession(userKey)
  ) {
    roundManager.createBonusSession(userKey, {
      betAmount,
      freeSpins: FREE_SPINS_NATURAL,
    });
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

  if (isFreeSpin) {
    bonusSession.totalWon = roundMoney(bonusSession.totalWon + totalWin);
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
  publishSpinCompleted(userKey, { sourceId: round.roundId, game: "poseidon" });

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
    freeSpinsRemaining:
      roundManager.getBonusSession(userKey)?.freeSpinsRemaining ?? 0,
    bonusTotalWon: isFreeSpin ? bonusSession.totalWon : 0,
    balance: roundMoney(balanceAfter),
  };
}

/**
 * Buy bonus: pay the fixed cost and open a 10-free-spin session directly —
 * no forced trigger spin, the outcome is whatever the spins deal.
 */
async function executeBuyBonus(userId, currentBetInput) {
  const userKey = String(userId);
  if (roundManager.hasActiveBonusSession(userKey)) {
    throw new ApiError("Bonus session already active", 409);
  }

  const betAmount = validateBet(currentBetInput);
  const cost = roundMoney(betAmount * BUY_BONUS_COST);

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
  });

  const balanceAfter = await wallet.getBalance(userKey);

  return {
    sessionId: session.sessionId,
    cost,
    betAmount,
    freeSpinsTriggered: true,
    freeSpinsAwarded: FREE_SPINS_BOUGHT,
    freeSpinsRemaining: session.freeSpinsRemaining,
    balance: roundMoney(balanceAfter),
  };
}

module.exports = {
  executeSpin,
  executeBuyBonus,
  validateBet,
};
