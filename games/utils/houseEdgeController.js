/**
 * Centralized House Edge & Dynamic Engagement Controller
 *
 * Implements bet-size-adaptive mathematical modulation:
 * 1. Small bets (Micro/Min): High hit frequency, generous multipliers, engaging gameplay.
 * 2. Big/Whale bets: Controlled house edge, softened payouts, exciting near-misses.
 * 3. Adaptive streak feedback: Prevents churn from long cold streaks.
 */

const config = require("./houseEdgeConfig");
const { evaluateStreak, recordSpin } = require("./rtpTracker");

/**
 * Resolve the bet tier based on the bet ratio = (betAmount / betMin).
 */
function resolveTier(betAmount, betMin = 10000) {
  const min = Math.max(1, Number(betMin) || 10000);
  const bet = Math.max(0, Number(betAmount) || min);
  const ratio = bet / min;

  for (const tier of config.TIERS) {
    if (ratio <= tier.maxRatio) {
      return { tier, ratio };
    }
  }
  return { tier: config.TIERS[config.TIERS.length - 1], ratio };
}

/**
 * Calculate the active edge parameters for a spin.
 *
 * @param {object} params
 * @param {string} params.game - 'zenobia' | 'poseidon' | 'golden-tree'
 * @param {number} params.betAmount - Current wager in coins
 * @param {number} [params.betMin] - Table minimum bet (defaults to 10000)
 * @param {string|number} [params.userId] - Player ID for streak balancing
 * @param {boolean} [params.isBonusSpin] - Whether this is a free/bonus spin
 * @returns {object} edgeParams
 */
function calculateEdge({
  game = "unknown",
  betAmount = 10000,
  betMin = 10000,
  userId = null,
  isBonusSpin = false,
  economyVersion = 2,
} = {}) {
  if (!config.ENABLED) {
    return {
      enabled: false,
      game,
      betAmount,
      betMin,
      ratio: 1,
      tierName: "default",
      plaqueWinKeep: 0.5,
      winCapMultiplier: 5000,
      highMultiplierDampening: 1.0,
      wildMultiplierBoost: 1.0,
      modulateMultiplierWeights: (vals, w) => [...w],
      modulateSymbolWeights: (w) => [...w],
    };
  }

  const { tier, ratio } = resolveTier(betAmount, betMin);
  const fixedSlot = economyVersion >= 2 && ["poseidon", "zenobia", "golden-tree"].includes(game);
  const streak = userId && !fixedSlot ? evaluateStreak(userId) : { status: "neutral", factor: 1.0 };

  // Adjusted hit rate combining bet tier with streak feedback
  const effectiveHitMultiplier = Math.max(
    0.35,
    Math.min(1.6, tier.hitRateMultiplier * streak.factor)
  );

  const dampening = tier.highMultiplierDampening;
  const plaqueWinKeep = tier.plaqueWinKeep;
  const wildMultiplierBoost = tier.wildMultiplierBoost;

  /**
   * Modulate multiplier face distribution:
   * Leaves small multipliers (<= x5) intact, while progressively dampening
   * high multipliers (x10+) for larger bets.
   */
  function modulateMultiplierWeights(values, baseWeights) {
    if (!Array.isArray(values) || !Array.isArray(baseWeights)) return baseWeights;
    if (dampening >= 0.99) return [...baseWeights];

    return baseWeights.map((w, i) => {
      const val = Number(values[i]) || 0;
      if (val <= 5) return w; // x2, x3, x4, x5 remain standard
      if (val <= 10) return w * Math.max(0.3, dampening * 1.1);
      if (val <= 20) return w * Math.max(0.2, dampening);
      // For royal/mega multipliers (x50 - x1000), apply full tier dampening
      return w * Math.max(0.05, dampening * 0.8);
    });
  }

  /**
   * Modulate symbol draw weights (Zeus / Poseidon):
   * For small bets: slightly favor regular paying symbols to ensure high hit rate.
   * For whale bets: shift weight toward letter / low symbols and route breakers.
   */
  function modulateSymbolWeights(weightsTable) {
    if (!Array.isArray(weightsTable)) return weightsTable;
    if (Math.abs(effectiveHitMultiplier - 1.0) < 0.05) return [...weightsTable];

    return weightsTable.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return entry;
      const [symbol, originalWeight] = entry;
      let newWeight = originalWeight;

      // Check if royal / high paying
      const isHighPay = [
        "queen", "throne", "necklace", // Zeus
        "crown", "fish", "pearl",      // Poseidon
      ].includes(symbol);

      const isLowLetter = ["a", "e", "n", "s"].includes(symbol);

      if (effectiveHitMultiplier > 1.0) {
        // Boost tier (small bet / losing streak): increase paying symbols slightly
        if (isHighPay) newWeight = originalWeight * 1.15;
        else if (isLowLetter) newWeight = originalWeight * 1.10;
      } else {
        // Dampened tier (high bet): shift from top premiums to letters
        if (isHighPay) newWeight = originalWeight * Math.max(0.5, effectiveHitMultiplier);
        else if (isLowLetter) newWeight = originalWeight * (1.0 + (1.0 - effectiveHitMultiplier) * 0.3);
      }

      return [symbol, Math.max(0.01, newWeight)];
    });
  }

  /**
   * Modulate Golden Tree wild multiplier distribution:
   * Boosts multipliers for small bets, clamps them toward x1 for big bets.
   */
  function modulateWildMultiplierWeights(baseWeights) {
    if (!Array.isArray(baseWeights)) return baseWeights;
    return baseWeights.map(([mult, weight]) => {
      if (mult === 1) {
        // Plain wild: higher share on big bets, lower share on small bets
        const adjusted = wildMultiplierBoost < 1.0
          ? weight * (1.0 + (1.0 - wildMultiplierBoost) * 1.5)
          : weight * 0.85;
        return [mult, Math.max(1, Math.round(adjusted))];
      }
      // Boosted multipliers (x2, x3, x5) - scale by 10 to preserve precision then round
      const scaled = Math.round(weight * wildMultiplierBoost * 10);
      return [mult, Math.max(1, scaled)];
    });
  }

  /**
   * Logarithmically compresses windfall spikes on large bets to protect house bank
   * while ensuring the player still feels the thrill of a massive win.
   */
  function modulateWinMultiple(winMult) {
    const mult = Math.max(0, Number(winMult) || 0);
    if (ratio <= 2 || mult <= 30) {
      // Small bet or moderate win: pay 100% full
      return mult;
    }
    if (ratio <= 10) {
      // Medium bet: compress only above 100x
      if (mult <= 100) return mult;
      return 100 + Math.pow(mult - 100, 0.85);
    }
    if (ratio <= 50) {
      // High bet: compress above 60x
      if (mult <= 60) return mult;
      return 60 + Math.pow(mult - 60, 0.72);
    }
    // Whale bet: compress above 35x
    if (mult <= 35) return mult;
    return 35 + Math.pow(mult - 35, 0.60);
  }

  return {
    enabled: true,
    game,
    betAmount,
    betMin,
    ratio,
    tierName: tier.name,
    targetRtp: tier.targetRtp,
    hitRateMultiplier: effectiveHitMultiplier,
    streakStatus: streak.status,
    plaqueWinKeep,
    wildMultiplierBoost,
    winCapMultiplier: tier.winCapMultiplier || 5000,
    modulateMultiplierWeights,
    modulateSymbolWeights,
    modulateWildMultiplierWeights,
    modulateWinMultiple,
  };
}

module.exports = {
  calculateEdge,
  resolveTier,
  recordSpin,
};
