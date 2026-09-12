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
  winTierFor,
  roundMoney,
} = require("./constants");
const spinEngine = require("./spinEngine");
const roundManager = require("./roundManager");
const zenobiaJackpot = require("./zenobiaJackpot");
const wallet = require("./zenobiaWalletAdapter");


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

/** Attach coin amounts to engine steps (the engine works in bet multiples). */
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

/** Execute one round — a paid spin, or a free spin from an active session. */
async function executeSpin(userId, betAmountInput) {
  const userKey = String(userId);

  return wallet.withUserLock(userKey, async () => {
    await roundManager.ensureLoaded(userKey);
    const bonusSession = roundManager.getBonusSession(userKey);
    const isFreeSpin = bonusSession != null && bonusSession.freeSpinsRemaining > 0;

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

    // --- Bonus Box math (bet multiples) ---
    // Base game: the plaques banked this sequence multiply a winning cascade and
    // the box empties afterwards. Free spins: the box carries, and only a
    // winning spin adds to it. Total is still hard-capped by MAX_WIN_MULTIPLIER.
    const carried = isFreeSpin ? Number(bonusSession.bonusMultiplier || 0) : 0;
    const { applied: appliedMultiplier, nextCarried } = resolvePayoutMultiplier({
      baseWin: spin.baseWin,
      plaqueSum: spin.multiplierSum,
      carried,
      isFreeSpin,
    });
    if (isFreeSpin) {
      roundManager.setBonusMultiplier(userKey, nextCarried);
    }

    let totalWinX = spin.baseWin * appliedMultiplier;
    const winCapped = totalWinX > MAX_WIN_MULTIPLIER;
    if (winCapped) totalWinX = MAX_WIN_MULTIPLIER;

    const totalWin = roundMoney(totalWinX * betAmount);

    // --- free spins: 3+ BONUS coins in base, 2+ during the bonus ---
    const scatterCount = spin.scatterCount;
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

    let jackpotGame = null;
    if (zenobiaJackpot.isJackpotTriggered(spin.finalMatrix)) {
      try {
        jackpotGame = await zenobiaJackpot.createRoundForSpin({
          spinId: round.roundId,
          userId: userKey,
        });
      } catch (err) {
        console.error?.("[zenobia] jackpot round creation failed", err?.message || err);
        jackpotGame = null;
      }
    }

    const {
      publishSpinCompleted,
    } = require("../../domain/publishers/playerActivityPublishers");
    publishSpinCompleted(userKey, {
      sourceId: round.roundId,
      game: "zenobia",
      won: Number(totalWin || 0) > 0,
    });

    const liveSession = roundManager.getBonusSession(userKey);

    return {
      roundId: round.roundId,
      roundHash: round.roundHash,
      betAmount,
      initialMatrix: spin.initialMatrix,
      steps: stepsWithAmounts(spin.steps, betAmount),
      finalMatrix: spin.finalMatrix,
      multipliers: spin.multipliers,
      multiplierSum: spin.multiplierSum,
      multiplierCount: spin.multipliers.length,
      appliedMultiplier,
      bonusMultiplier: isFreeSpin ? nextCarried : 0,
      scatters: spin.scatters,
      scatterCount,
      jackpotCount: spin.jackpotCount || 0,
      jackpotGame,
      baseWinAmount: roundMoney(spin.baseWin * betAmount),
      totalWin,
      winCapped,
      maxWinCap: roundMoney(MAX_WIN_MULTIPLIER * betAmount),
      winTier: winTierFor(totalWinX),
      isFreeSpin,
      superBonus,
      freeSpinsTriggered,
      freeSpinsAwarded,
      freeSpinsRemaining: liveSession?.freeSpinsRemaining ?? 0,
      bonusTotalWon: isFreeSpin ? bonusTotalWon : 0,
      balance: roundMoney(balanceAfter),
    };
  });
}

/**
 * Buy bonus: pay the fixed cost and open a free-spins session directly — no
 * forced trigger spin, the outcome is whatever the spins deal.
 */
async function executeBuyBonus(userId, currentBetInput, { superBonus = false } = {}) {
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
    sessionId: session.sessionId,
    betAmount: session.betAmount,
    freeSpinsRemaining: session.freeSpinsRemaining,
    bonusTotalWon: session.totalWon,
    superBonus: !!session.superBonus,
    bonusMultiplier: Number(session.bonusMultiplier || 0),
  };
}

module.exports = {
  executeSpin,
  executeBuyBonus,
  getActiveSession,
  validateBet,
};
