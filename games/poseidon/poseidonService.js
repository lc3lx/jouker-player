const slotOperation = require("../utils/slotOperation");
const ApiError = require("../../utils/apiError");
const {
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  BUY_BONUS_COST,
  SUPER_BUY_BONUS_COST,
  FREE_SPINS_BOUGHT,
  winTierFor,
  roundMoney,
} = require("./constants");
// Read at call time so tests can lift the legacy standard-buy pause.
const poseidonConstants = require("./constants");
const economyRuntime = require("../utils/slotEconomyRuntime");
const economyStats = require("../utils/slotEconomyStats");
const spinEngine = require("./spinEngine");
const { settleSpin } = require("./settlement");
const roundManager = require("./roundManager");
const wallet = require("./poseidonWalletAdapter");
const jackpotService = require("./jackpot/jackpotService");
const { settleJackpotRound } = require("./jackpot/jackpotSettlement");
const { recordAggregate } = require("../utils/rtpTracker");

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
  const { min, max } = economyRuntime.betLimits("poseidon", BET_MIN, BET_MAX);
  if (!Number.isFinite(bet) || bet < min || bet > max) {
    throw new ApiError(`Bet must be between ${min} and ${max} coins`, 400);
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

    if (!isFreeSpin) economyRuntime.assertPaidPlayOpen("poseidon");
    const betAmount = isFreeSpin
      ? bonusSession.betAmount
      : validateBet(betAmountInput);

    if (!isFreeSpin) {
      const balance = await wallet.getBalance(userKey);
      if (balance < betAmount) {
        throw new ApiError("Insufficient wallet balance", 402);
      }
    }

    // One global, disclosed profile — no per-player or bet-size parameters. A
    // bonus round keeps the engine + profile it was opened with.
    const { economyVersion, profile, rules } = economyRuntime.resolveEconomy(
      "poseidon",
      isFreeSpin ? bonusSession : null,
      3,
    );
    const superBonus = !!(isFreeSpin && bonusSession.superBonus);
    const spin = spinEngine.resolveSpin({
      bonusMode: isFreeSpin,
      superBonus,
      economyVersion,
      profile,
      rng: slotOperation.rng(),
    });

    // --- win math (bet multiples) + bonus entitlement: shared settlement ---
    const settled = settleSpin({
      spin,
      economyVersion,
      rules,
      session: isFreeSpin ? bonusSession : null,
      canTrigger: !roundManager.hasActiveBonusSession(userKey),
    });
    const { applied: appliedMultiplier, nextCarried, winCapped, scatterCount } = settled;
    const totalWinX = settled.winX;
    const totalWin = roundMoney(totalWinX * betAmount);
    // paid | natural | buy | super — legacy sessions predate the origin tag.
    const spinOrigin = !isFreeSpin
      ? "paid"
      : bonusSession.origin || (bonusSession.superBonus ? "super" : "natural");
    const multiplierCount = spin.multipliers.length;

    let freeSpinsTriggered = false;
    let freeSpinsAwarded = 0;
    let stagedBonusAction = null;
    if (settled.award?.type === "retrigger") {
      stagedBonusAction = { type: "retrigger", spins: settled.award.spins };
      freeSpinsAwarded = settled.award.spins;
    } else if (settled.award?.type === "create") {
      stagedBonusAction = { type: "create", betAmount, freeSpins: settled.award.spins };
      freeSpinsTriggered = true;
      freeSpinsAwarded = settled.award.spins;
    }

    // --- settlement ---
    let balanceAfter;
    try {
      balanceAfter = await wallet.atomicSpinWallet(userKey, {
        betAmount: isFreeSpin ? 0 : betAmount,
        winAmount: totalWin,
        meta: {
          type: isFreeSpin ? "free_spin" : "main_spin",
          profileId: profile?.id ?? null,
          origin: spinOrigin,
          sessionId: bonusSession?.sessionId ?? null,
        },
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
          economyVersion,
          profileId: profile?.id ?? null,
          origin: "natural",
          // The cumulative round cap counts the triggering spin, as Zeus does.
          roundWonX: profile ? totalWinX : 0,
        });
        await roundManager.touchSession(userKey);
      }
    }

    let bonusTotalWon = 0;
    if (isFreeSpin) {
      // A rejected wallet settlement must not bank this spin's plaques.
      roundManager.setBonusMultiplier(userKey, nextCarried);
      roundManager.addBonusWin(userKey, totalWin);
      roundManager.addRoundWin(userKey, totalWinX);
      bonusTotalWon = roundManager.getBonusSession(userKey)?.totalWon ?? 0;
      if (settled.capReached) roundManager.endBonusSession(userKey);
      else roundManager.consumeBonusSpin(userKey);
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
    slotOperation.afterCommit(() => recordAggregate("poseidon", isFreeSpin ? 0 : betAmount, totalWin));
    slotOperation.afterCommit(() => (isFreeSpin
      ? economyStats.recordFreeSpin({
        game: "poseidon", profileId: profile?.id, economyVersion, origin: spinOrigin,
        win: totalWin, winX: totalWinX, roundCapped: settled.capReached,
      })
      : economyStats.recordPaidSpin({
        game: "poseidon", profileId: profile?.id, economyVersion, bet: betAmount, win: totalWin, winX: totalWinX,
        plaque: spin.multipliers.length > 0, naturalTrigger: freeSpinsTriggered,
        jackpotTrigger: (spin.jackpotCount ?? spin.finalMatrix.flat().filter((c) => c === "jackpot").length) >= 3,
      })));

    const liveSession = roundManager.getBonusSession(userKey);

    // --- jackpot round (server-authoritative) ---
    let jackpotGame = null;
    if (jackpotService.isJackpotTriggered(spin.finalMatrix)) {
      try {
        jackpotGame = await jackpotService.createJackpotRound({
          spinId: round.roundId,
          betAmount,
          userId: userKey,
          profileId: profile?.id ?? null,
          economyVersion,
          origin: spinOrigin,
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
      maxWinCap: roundMoney((rules?.maxWinX ?? MAX_WIN_MULTIPLIER) * betAmount),
      roundCapReached: !!settled.capReached,
      economyVersion,
      profileId: profile?.id ?? null,
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
async function executeBuyBonusInternal(userId, currentBetInput, { superBonus = false, expectedCost = null } = {}) {
  const userKey = String(userId);
  return wallet.withUserLock(userKey, async () => {
    await roundManager.ensureLoaded(userKey);
    if (roundManager.hasActiveBonusSession(userKey)) {
      throw new ApiError("Bonus session already active", 409);
    }

    const betAmount = validateBet(currentBetInput);
    const { cost, profile } = economyRuntime.quoteBuy("poseidon", {
      betAmount,
      superBonus,
      expectedCost,
      legacyCost: superBonus ? SUPER_BUY_BONUS_COST : BUY_BONUS_COST,
      legacyPaused: !superBonus && poseidonConstants.STANDARD_BUY_PAUSED,
      roundMoney,
    });

    const balance = await wallet.getBalance(userKey);
    if (balance < cost) {
      throw new ApiError("Insufficient wallet balance for bonus purchase", 402);
    }

    try {
      await wallet.deductBalance(userKey, cost, {
        leg: "buy_bonus",
        profileId: profile?.id ?? null,
        origin: superBonus ? "super" : "buy",
      });
    } catch (err) {
      mapWalletError(err);
    }

    const session = roundManager.createBonusSession(userKey, {
      betAmount,
      freeSpins: profile ? profile.rules.freeSpinsBought : FREE_SPINS_BOUGHT,
      superBonus: !!superBonus,
      economyVersion: profile ? profile.economyVersion : 3,
      profileId: profile?.id ?? null,
      origin: superBonus ? "super" : "buy",
      costPaid: cost,
    });
    await roundManager.touchSession(userKey);

    slotOperation.afterCommit(() => recordAggregate("poseidon", cost, 0));
    slotOperation.afterCommit(() => economyStats.recordBuy({
      game: "poseidon", profileId: profile?.id, economyVersion: session.economyVersion, superBonus: !!superBonus, cost,
    }));
    const balanceAfter = await wallet.getBalance(userKey);

    return {
      sessionId: session.sessionId,
      cost,
      betAmount,
      superBonus: !!superBonus,
      profileId: profile?.id ?? null,
      freeSpinsTriggered: true,
      freeSpinsAwarded: session.freeSpinsRemaining,
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
    economyVersion: session.economyVersion || 3,
    profileId: session.profileId || null,
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
  return slotOperation.run({ game: "poseidon", userId, wallet, manager: roundManager, modelName: "poseidonBonusSessionModel", requestId: options.requestId, input: ["buy", currentBet, !!options.superBonus, options.expectedCost ?? null] }, () => executeBuyBonusInternal(userId, currentBet, options));
}
