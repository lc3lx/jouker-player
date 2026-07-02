/** Production hand pacing (ms). Override via env POKER_TIMING_* */

function envMs(key, fallback) {
  const v = parseInt(process.env[key] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const POKER_TIMINGS = {
  PREFLOP_DEAL_MS: envMs("POKER_TIMING_PREFLOP_DEAL_MS", 2000),
  TURN_SECONDS: envMs("POKER_TIMING_TURN_SECONDS", 20),
  ACTION_REVEAL_MS: envMs("POKER_TIMING_ACTION_REVEAL_MS", 1000),
  FLOP_MS: envMs("POKER_TIMING_FLOP_MS", 2000),
  TURN_STREET_MS: envMs("POKER_TIMING_TURN_STREET_MS", 2000),
  RIVER_MS: envMs("POKER_TIMING_RIVER_MS", 2000),
  SHOWDOWN_MS: envMs("POKER_TIMING_SHOWDOWN_MS", 4000),
  WINNER_POT_MS: envMs("POKER_TIMING_WINNER_POT_MS", 3000),
  NEXT_HAND_DELAY_MS: envMs("POKER_TIMING_NEXT_HAND_MS", 5000),
  RECONNECT_WINDOW_MS: envMs("POKER_RECONNECT_WINDOW_MS", 90000),
  /** Seat vacate grace period before a bot replaces the leaving player. */
  VACATE_WINDOW_MS: envMs("POKER_VACATE_WINDOW_MS", 30000),
  /** Lobby wait window while seated alone before bot fill + start. */
  WAIT_FOR_PLAYERS_MS: envMs("POKER_WAIT_FOR_PLAYERS_MS", 8000),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

module.exports = { POKER_TIMINGS, sleep };
