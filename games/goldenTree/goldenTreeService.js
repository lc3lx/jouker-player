const ApiError = require("../../utils/apiError");
const {
  BET_MIN,
  BET_MAX,
  MAX_WIN_MULTIPLIER,
  BUY_BONUS_COSTS,
  BONUS_GUARANTEED_WILDS,
  RESOLVED_BONUS_TYPES,
  roundMoney,
} = require("./constants");
const { generateSpin, pickFromArray, secureRandomInt } = require("./spinEngine");
const { calculateWins } = require("./winCalculator");
const roundManager = require("./roundManager");
const wallet = require("./goldenTreeWalletAdapter");

function validateBet(betAmount) {
  const bet = roundMoney(betAmount);
  if (!Number.isFinite(bet) || bet < BET_MIN || bet > BET_MAX) {
    throw new ApiError(`Bet must be between ${BET_MIN} and ${BET_MAX} FUN`, 400);
  }
  return bet;
}

function capWin(totalWin, betAmount) {
  const cap = roundMoney(betAmount * MAX_WIN_MULTIPLIER);
  if (totalWin <= cap) {
    return { totalWin, capped: false, cap };
  }
  return { totalWin: cap, capped: true, cap };
}

function formatMatrixForClient(matrix) {
  return matrix.map((col) => [...col]);
}

function buildSpinResponse(round, balance, extra = {}) {
  return {
    roundId: round.roundId,
    roundHash: round.roundHash,
    betAmount: round.betAmount,
    matrix: formatMatrixForClient(round.matrix),
    expandedWilds: round.expandedWilds,
    lineWins: round.lineWins,
    scatterWins: round.scatterWins,
    totalWin: round.totalWin,
    currentWin: round.currentWin,
    balance: roundMoney(balance),
    gambleEligible: roundManager.isGambleEligible(round),
    maxGambleAttempts: round.maxGambleAttempts,
    gambleAttemptsUsed: round.gambleAttemptsUsed,
    ...extra,
  };
}

async function executeSpin(userId, betAmountInput) {
  const userKey = String(userId);
  const bonusSession = roundManager.getBonusSession(userKey);
  const isBonusSpin =
    bonusSession != null && bonusSession.freeSpinsRemaining > 0;

  const betAmount = isBonusSpin
    ? bonusSession.betAmount
    : validateBet(betAmountInput);

  if (!isBonusSpin) {
    const balance = await wallet.getBalance(userKey);
    if (balance < betAmount) {
      throw new ApiError("Insufficient wallet balance", 402);
    }
  }

  let guaranteedWilds = 0;
  if (isBonusSpin) {
    const resolved = bonusSession.resolvedType || bonusSession.bonusType;
    guaranteedWilds = BONUS_GUARANTEED_WILDS[resolved] || 1;
    roundManager.consumeBonusSpin(userKey);
  }

  const { matrix, wildMultipliers } = generateSpin({
    bonusMode: isBonusSpin,
    guaranteedWilds,
  });

  const winResult = calculateWins(matrix, wildMultipliers, betAmount);
  const { totalWin, capped, cap } = capWin(winResult.totalWin, betAmount);

  const round = roundManager.createRound({
    userId: userKey,
    betAmount,
    matrix: winResult.expandedMatrix,
    expandedWilds: winResult.expandedWilds,
    lineWins: winResult.lineWins,
    scatterWins: winResult.scatterWins,
    totalWin,
    isFreeSpin: isBonusSpin,
    isBonusRound: isBonusSpin,
    bonusSessionId: bonusSession?.sessionId || null,
  });

  if (capped) {
    roundManager.settleRound(round.roundId);
  }

  const balanceAfter = await wallet.atomicSpinWallet(userKey, {
    betAmount: isBonusSpin ? 0 : betAmount,
    winAmount: totalWin,
    meta: {
      roundId: round.roundId,
      type: isBonusSpin ? "bonus_spin" : "main_spin",
    },
  });

  const remainingBonus = roundManager.getBonusSession(userKey);

  return buildSpinResponse(round, balanceAfter, {
    winCapped: capped,
    maxWinCap: cap,
    isFreeSpin: isBonusSpin,
    bonusSessionId: bonusSession?.sessionId || null,
    freeSpinsRemaining: remainingBonus?.freeSpinsRemaining ?? 0,
  });
}

async function executeGamble(userId, roundId, choice) {
  const normalizedChoice = String(choice || "").trim();
  if (!["Red", "Black"].includes(normalizedChoice)) {
    throw new ApiError("choice must be 'Red' or 'Black'", 400);
  }

  const round = roundManager.getRoundForUser(roundId, userId);
  if (!round) throw new ApiError("Round not found or expired", 404);
  if (!roundManager.isGambleEligible(round)) {
    throw new ApiError("Gamble not available for this round", 403);
  }

  const stake = round.currentWin;
  await wallet.deductBalance(String(userId), stake, {
    roundId,
    leg: "gamble_stake",
  });

  const cardIsRed = secureRandomInt(2) === 0;
  const cardColor = cardIsRed ? "Red" : "Black";
  const won = cardColor === normalizedChoice;
  const newWin = won ? roundMoney(stake * 2) : 0;

  if (newWin > 0) {
    await wallet.creditBalance(String(userId), newWin, {
      roundId,
      leg: "gamble_win",
    });
  }

  const updated = roundManager.recordGamble(roundId, {
    choice: normalizedChoice,
    cardColor,
    won,
    previousWin: stake,
    newWin,
    at: Date.now(),
  });

  const balance = await wallet.getBalance(String(userId));

  return {
    roundId,
    cardColor,
    won,
    previousWin: stake,
    currentWin: updated.currentWin,
    balance: roundMoney(balance),
    gambleAttemptsUsed: updated.gambleAttemptsUsed,
    maxGambleAttempts: updated.maxGambleAttempts,
    gambleEligible: roundManager.isGambleEligible(updated),
    gambleHistory: updated.gambleHistory,
  };
}

async function executeBuyBonus(userId, bonusTypeInput, currentBetInput) {
  if (roundManager.hasFreeBet(String(userId))) {
    throw new ApiError("Buy Bonus inactive while free bet is active", 403);
  }
  if (roundManager.hasActiveBonusSession(String(userId))) {
    throw new ApiError("Bonus session already active", 409);
  }

  const bonusType = String(bonusTypeInput || "").trim();
  if (!Object.keys(BUY_BONUS_COSTS).includes(bonusType)) {
    throw new ApiError("Invalid bonusType", 400);
  }

  const betAmount = validateBet(currentBetInput);
  const costMultiplier = BUY_BONUS_COSTS[bonusType];
  const cost = roundMoney(betAmount * costMultiplier);

  const balance = await wallet.getBalance(String(userId));
  if (balance < cost) {
    throw new ApiError("Insufficient wallet balance for bonus purchase", 402);
  }

  let resolvedType = bonusType;
  if (bonusType === "Random") {
    resolvedType = RESOLVED_BONUS_TYPES[secureRandomInt(RESOLVED_BONUS_TYPES.length)];
  }

  await wallet.deductBalance(String(userId), cost, {
    leg: "buy_bonus",
    bonusType,
    resolvedType,
  });

  const session = roundManager.createBonusSession(String(userId), {
    bonusType,
    resolvedType,
    betAmount,
  });

  const balanceAfter = await wallet.getBalance(String(userId));

  return {
    sessionId: session.sessionId,
    bonusType,
    resolvedType,
    cost,
    betAmount,
    freeSpinsRemaining: session.freeSpinsRemaining,
    gambleLocked: true,
    balance: roundMoney(balanceAfter),
  };
}

module.exports = {
  executeSpin,
  executeGamble,
  executeBuyBonus,
  validateBet,
  capWin,
};
