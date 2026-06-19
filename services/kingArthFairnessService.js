const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const DiceEngine = require("../games/dice/DiceEngine");
const { listRevealedSeeds } = require("../games/dice/kingArthSeedRotation");
const { getSessionSummary } = require("../games/dice/kingArthAnalytics");

/**
 * POST body: verify a round offline after serverSeed was revealed.
 */
exports.verifySpin = asyncHandler(async (req, res, next) => {
  const {
    serverSeed,
    clientSeed,
    nonce,
    baseBet,
    doubleChance,
    isFreeSpin,
    freeSpinMultiplier,
    volatility,
  } = req.body || {};

  if (typeof serverSeed !== "string" || serverSeed.length < 16) {
    return next(new ApiError("serverSeed required", 400));
  }
  if (typeof clientSeed !== "string" || clientSeed.length < 8) {
    return next(new ApiError("clientSeed required", 400));
  }
  if (nonce == null || String(nonce).length === 0) {
    return next(new ApiError("nonce required", 400));
  }

  const bet = Number(baseBet);
  if (Number.isNaN(bet) || bet <= 0) {
    return next(new ApiError("baseBet invalid", 400));
  }

  try {
    const outcome = DiceEngine.spin(bet, {
      serverSeed,
      clientSeed,
      nonce: String(nonce),
      doubleChance: !!doubleChance,
      isFreeSpin: !!isFreeSpin,
      freeSpinMultiplier: Number(freeSpinMultiplier || 0),
      volatility: volatility || "medium",
    });
    res.status(200).json({
      status: "success",
      data: {
        grid: outcome.grid,
        initialGrid: outcome.initialGrid,
        finalGrid: outcome.finalGrid,
        totalWin: outcome.totalWin,
        baseWin: outcome.baseWin,
        winType: outcome.winType,
        scatterCount: outcome.scatterCount,
        stake: outcome.stake,
        volatility: outcome.volatility,
        multipliers: outcome.multipliers,
        nearMiss: outcome.nearMiss,
        almostBonus: outcome.almostBonus,
        winningCells: outcome.winningCells,
        lineWins: outcome.lineWins,
        cascadeSteps: outcome.cascadeSteps,
      },
    });
  } catch (_e) {
    return next(new ApiError("verification_failed", 400));
  }
});

exports.listRevealedSeeds = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const list = await listRevealedSeeds(userId);
  res.status(200).json({ status: "success", results: list.length, data: list });
});

exports.getSessionAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const summary = await getSessionSummary(userId);
  res.status(200).json({ status: "success", data: summary });
});
