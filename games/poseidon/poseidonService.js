const ApiError = require("../../utils/apiError");
const {
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  BUY_BONUS_COST,
  FREE_SPINS_AWARD,
  RETRIGGER_AWARD,
  TRIGGER_MIN_SCATTERS,
  RETRIGGER_MIN_SCATTERS,
  scatterPayFor,
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

/**
 * Execute one round. `chargeBet: false` + `forceScatters` is the buy-bonus
 * trigger spin (already paid for by the bonus purchase).
 */
async function executeSpin(userId, betAmountInput, options = {}) {
  const { chargeBet = true, forceScatters = 0 } = options;
  const userKey = String(userId);

  const bonusSession = roundManager.getBonusSession(userKey);
  const isFreeSpin =
    bonusSession != null && bonusSession.freeSpinsRemaining > 0;

  const betAmount = isFreeSpin
    ? bonusSession.betAmount
    : validateBet(betAmountInput);

  const paysBet = !isFreeSpin && chargeBet;
  if (paysBet) {
    const balance = await wallet.getBalance(userKey);
    if (balance < betAmount) {
      throw new ApiError("Insufficient wallet balance", 402);
    }
  }

  const spin = resolveSpin({ bonusMode: isFreeSpin, forceScatters });

  // --- win math (bet multiples) ---
  let appliedMultiplier = 1;
  if (spin.baseWin > 0) {
    if (isFreeSpin) {
      // Gates-style: orbs landing on a winning free spin grow the session
      // multiplier, and the grown total applies to this spin's win. Winning
      // spins without orbs pay unmultiplied.
      if (spin.multiplierSum > 0) {
        bonusSession.totalMultiplier += spin.multiplierSum;
        appliedMultiplier = bonusSession.totalMultiplier;
      }
    } else if (spin.multiplierSum > 0) {
      appliedMultiplier = spin.multiplierSum;
    }
  }
  const tumbleWinX = spin.baseWin * appliedMultiplier;
  const scatterPayX = scatterPayFor(spin.scatterCount);

  let totalWinX = tumbleWinX + scatterPayX;
  const winCapped = totalWinX > MAX_WIN_MULTIPLIER;
  if (winCapped) totalWinX = MAX_WIN_MULTIPLIER;

  const totalWin = roundMoney(totalWinX * betAmount);

  // --- free spins trigger / retrigger ---
  let freeSpinsTriggered = false;
  let freeSpinsAwarded = 0;
  if (isFreeSpin) {
    if (spin.scatterCount >= RETRIGGER_MIN_SCATTERS) {
      roundManager.addRetriggerSpins(userKey, RETRIGGER_AWARD);
      freeSpinsAwarded = RETRIGGER_AWARD;
    }
  } else if (
    spin.scatterCount >= TRIGGER_MIN_SCATTERS &&
    !roundManager.hasActiveBonusSession(userKey)
  ) {
    roundManager.createBonusSession(userKey, {
      betAmount,
      freeSpins: FREE_SPINS_AWARD,
    });
    freeSpinsTriggered = true;
    freeSpinsAwarded = FREE_SPINS_AWARD;
  }

  // --- settlement ---
  let balanceAfter;
  try {
    balanceAfter = await wallet.atomicSpinWallet(userKey, {
      betAmount: paysBet ? betAmount : 0,
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

  const session = roundManager.getBonusSession(userKey) ||
    (isFreeSpin ? bonusSession : null);

  return {
    roundId: round.roundId,
    roundHash: round.roundHash,
    betAmount,
    initialMatrix: spin.initialMatrix,
    steps: stepsWithAmounts(spin.steps, betAmount),
    finalMatrix: spin.finalMatrix,
    multipliers: spin.multipliers,
    multiplierSum: spin.multiplierSum,
    appliedMultiplier,
    baseWinAmount: roundMoney(spin.baseWin * betAmount),
    scatterPayAmount: roundMoney(scatterPayX * betAmount),
    totalWin,
    winCapped,
    maxWinCap: roundMoney(MAX_WIN_MULTIPLIER * betAmount),
    winTier: winTierFor(totalWinX),
    scatterCount: spin.scatterCount,
    isFreeSpin,
    freeSpinsTriggered,
    freeSpinsAwarded,
    freeSpinsRemaining: roundManager.getBonusSession(userKey)?.freeSpinsRemaining ?? 0,
    bonusTotalMultiplier: session?.totalMultiplier ?? 0,
    bonusTotalWon: isFreeSpin ? bonusSession.totalWon : 0,
    balance: roundMoney(balanceAfter),
  };
}

/**
 * Buy bonus: pay 100× bet, then run the (free) trigger spin with guaranteed
 * scatters — it creates the free-spins session like a natural trigger.
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

  const triggerSpin = await executeSpin(userKey, betAmount, {
    chargeBet: false,
    forceScatters: TRIGGER_MIN_SCATTERS,
  });

  return { cost, ...triggerSpin };
}

module.exports = {
  executeSpin,
  executeBuyBonus,
  validateBet,
};
