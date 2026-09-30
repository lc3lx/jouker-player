/**
 * Dynamic House Edge & Adaptive Engagement Configuration
 *
 * Configures the bet-tier RTP bands, hit rate modulations,
 * multiplier governors, and adaptive hooks across slot games:
 * - Zeus (Zenobia)
 * - Poseidon
 * - Golden Tree
 */

module.exports = {
  // Master toggle - if false, games use standard static RNG
  ENABLED: true,

  // Bet tiers based on ratio = (currentBet / minBet)
  TIERS: [
    {
      name: "hook_tier",
      maxRatio: 2, // Bet 1x - 2x minBet (e.g. 10,000 - 20,000)
      targetRtp: 0.975, // 97.5% RTP
      hitRateMultiplier: 1.25, // 25% more frequent wins
      highMultiplierDampening: 1.0, // 100% full high multiplier weights
      plaqueWinKeep: 0.80, // Poseidon: 80% of multiplier spins keep win
      wildMultiplierBoost: 1.30, // Golden tree: 30% more chance of x2, x3, x5 wilds
      nearMissFrequency: 0.20, // 20% teaser/near-miss boost
      winCapMultiplier: 5000,
    },
    {
      name: "standard_tier",
      maxRatio: 10, // Bet 2x - 10x minBet (e.g. 20,001 - 100,000)
      targetRtp: 0.945, // 94.5% RTP
      hitRateMultiplier: 1.00, // Standard hit rate
      highMultiplierDampening: 0.85, // Slight dampening on giant multipliers
      plaqueWinKeep: 0.50, // Poseidon standard
      wildMultiplierBoost: 1.00, // Standard
      nearMissFrequency: 0.15,
      winCapMultiplier: 5000,
    },
    {
      name: "controlled_tier",
      maxRatio: 50, // Bet 10x - 50x minBet (e.g. 100,001 - 500,000)
      targetRtp: 0.895, // 89.5% RTP
      hitRateMultiplier: 0.75, // 25% fewer winning spins
      highMultiplierDampening: 0.45, // 55% reduction on >x10 multipliers
      plaqueWinKeep: 0.28, // Poseidon: only 28% of multiplier spins keep win
      wildMultiplierBoost: 0.45, // Golden tree: rarer high wild multipliers
      nearMissFrequency: 0.35, // High near-misses (excitement without payout)
      winCapMultiplier: 2500,
    },
    {
      name: "whale_tier",
      maxRatio: Infinity, // Bet > 50x minBet (e.g. > 500,000 up to 1,000,000,000)
      targetRtp: 0.815, // 81.5% RTP (strong house defense)
      hitRateMultiplier: 0.52, // Wins are rare and meaningful
      highMultiplierDampening: 0.18, // 82% reduction on giant multipliers
      plaqueWinKeep: 0.12, // Poseidon: 88% of multiplier screens fail to match
      wildMultiplierBoost: 0.15, // Golden tree: almost all wilds are x1
      nearMissFrequency: 0.45, // Heavy teaser near-misses
      winCapMultiplier: 1500,
    },
  ],

  // Adaptive streak balancing:
  // Keeps player engaged by preventing prolonged frustrating losing streaks
  // and curbing abnormal early jackpot runs
  ADAPTIVE: {
    ROLLING_WINDOW_SPINS: 50,
    // If player RTP in last N spins drops below this, provide a teaser/luck boost
    COLD_STREAK_RTP_FLOOR: 0.50,
    // If player RTP in last N spins exceeds this, apply soft cooling
    HOT_STREAK_RTP_CEILING: 1.40,
    // Max recovery boost factor
    MAX_RECOVERY_BOOST: 1.30,
    // Max cooling dampener factor
    MAX_COOLING_DAMPENER: 0.65,
  },
};
