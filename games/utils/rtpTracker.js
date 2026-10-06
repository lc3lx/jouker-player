/**
 * RTP Tracker & Player Session Telemetry
 *
 * Maintains rolling-window RTP history per player to support:
 * 1. Adaptive streak monitoring (preventing churn from harsh cold streaks)
 * 2. Real-time realized RTP metrics
 * 3. Persisting aggregate metrics to CasinoGameStats model
 */

const CasinoGameStats = require("../../models/casinoGameStatsModel");
const config = require("./houseEdgeConfig");

// Map: userId -> Array<{ bet: number, win: number, at: number }>
const playerHistories = new Map();
const MAX_HISTORY_PER_USER = config.ADAPTIVE.ROLLING_WINDOW_SPINS || 50;
const USER_HISTORY_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours idle TTL

/**
 * Record a settled spin for telemetry and adaptive feedback.
 */
function recordSpin(userId, gameKey, betAmount, winAmount) {
  const bet = Math.max(0, Number(betAmount) || 0);
  const win = Math.max(0, Number(winAmount) || 0);

  if (userId) {
    const key = String(userId);
    let history = playerHistories.get(key);
    if (!history) {
      history = [];
      playerHistories.set(key, history);
    }

    history.push({ bet, win, at: Date.now() });
    if (history.length > MAX_HISTORY_PER_USER) {
      history.shift();
    }
  }

  recordAggregate(gameKey, bet, win);
}

/**
 * Fold one settled spin into the game's lifetime CasinoGameStats totals only.
 * No per-player history: Poseidon, Zenobia and Zeus run a fixed, disclosed RTP
 * and must never feed (or be steered by) the per-player streak tracker.
 */
function recordAggregate(gameKey, betAmount, winAmount) {
  const bet = Math.max(0, Number(betAmount) || 0);
  const win = Math.max(0, Number(winAmount) || 0);

  // Aggregate into CasinoGameStats (non-blocking, only if mongoose is connected)
  const mongoose = require("mongoose");
  if (mongoose.connection && mongoose.connection.readyState === 1 && (bet > 0 || win > 0)) {
    // A free spin has no stake, so it can't be classified against one.
    const isBig = bet > 0 && win >= bet * 12;
    const isMega = bet > 0 && win >= bet * 50;

    const incUpdate = {
      totalBet: bet,
      totalPayout: win,
      spinCount: 1,
    };
    if (isMega) incUpdate.megaWinCount = 1;
    else if (isBig) incUpdate.bigWinCount = 1;

    CasinoGameStats.findOneAndUpdate(
      { gameKey },
      { $inc: incUpdate },
      { upsert: true, new: true }
    ).catch((err) => {
      if (process.env.NODE_ENV !== "test") {
        console.error?.("[rtpTracker] failed to update CasinoGameStats:", err?.message);
      }
    });
  }
}

/**
 * Get rolling RTP for a player over their recent spins.
 */
function getPlayerRollingRtp(userId) {
  if (!userId) return { rtp: 1.0, spins: 0, totalBet: 0, totalWin: 0 };
  const history = playerHistories.get(String(userId));
  if (!history || history.length === 0) {
    return { rtp: 1.0, spins: 0, totalBet: 0, totalWin: 0 };
  }

  let totalBet = 0;
  let totalWin = 0;
  for (const item of history) {
    totalBet += item.bet;
    totalWin += item.win;
  }

  const rtp = totalBet > 0 ? totalWin / totalBet : 1.0;
  return {
    rtp,
    spins: history.length,
    totalBet,
    totalWin,
  };
}

/**
 * Check if the player is in a cold streak (needs an engagement savior win)
 * or hot streak (needs slight cooling).
 */
function evaluateStreak(userId) {
  const { rtp, spins } = getPlayerRollingRtp(userId);
  if (spins < 10) {
    return { status: "neutral", factor: 1.0 };
  }

  const {
    COLD_STREAK_RTP_FLOOR,
    HOT_STREAK_RTP_CEILING,
    MAX_RECOVERY_BOOST,
    MAX_COOLING_DAMPENER,
  } = config.ADAPTIVE;

  if (rtp < COLD_STREAK_RTP_FLOOR) {
    // Player is losing heavily; boost win rate to prevent churn
    const severity = Math.min(1.0, (COLD_STREAK_RTP_FLOOR - rtp) / COLD_STREAK_RTP_FLOOR);
    const boost = 1.0 + severity * (MAX_RECOVERY_BOOST - 1.0);
    return { status: "cold", factor: boost };
  }

  if (rtp > HOT_STREAK_RTP_CEILING) {
    // Player is winning abnormally; apply soft cooling
    const severity = Math.min(1.0, (rtp - HOT_STREAK_RTP_CEILING) / HOT_STREAK_RTP_CEILING);
    const dampener = 1.0 - severity * (1.0 - MAX_COOLING_DAMPENER);
    return { status: "hot", factor: Math.max(MAX_COOLING_DAMPENER, dampener) };
  }

  return { status: "neutral", factor: 1.0 };
}

/** Clean up stale entries */
setInterval(() => {
  const now = Date.now();
  for (const [key, history] of playerHistories.entries()) {
    if (history.length === 0 || now - history[history.length - 1].at > USER_HISTORY_TTL_MS) {
      playerHistories.delete(key);
    }
  }
}, 30 * 60 * 1000).unref?.();

module.exports = {
  recordSpin,
  recordAggregate,
  getPlayerRollingRtp,
  evaluateStreak,
  _clearForTests: () => playerHistories.clear(),
};
