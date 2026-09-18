/** Production hand pacing (ms). Override via env POKER_TIMING_* */

function envMs(key, fallback) {
  const v = parseInt(process.env[key] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const POKER_TIMINGS = {
  INITIAL_DEAL_WAIT_MS: 15000,
  PREFLOP_DEAL_MS: envMs("POKER_TIMING_PREFLOP_DEAL_MS", 2000),
  TURN_SECONDS: envMs("POKER_TIMING_TURN_SECONDS", 20),
  ACTION_REVEAL_MS: envMs("POKER_TIMING_ACTION_REVEAL_MS", 1000),
  FLOP_MS: envMs("POKER_TIMING_FLOP_MS", 2000),
  TURN_STREET_MS: envMs("POKER_TIMING_TURN_STREET_MS", 2000),
  RIVER_MS: envMs("POKER_TIMING_RIVER_MS", 2000),
  /** Brief suspense after showdown starts, before the first hole-card flip. */
  SHOWDOWN_MS: envMs("POKER_TIMING_SHOWDOWN_MS", 1800),
  /** Hold all hole cards face-up so everyone can read the showdown. */
  SHOWDOWN_CARD_HOLD_MS: envMs("POKER_TIMING_SHOWDOWN_CARD_HOLD_MS", 5500),
  WINNER_POT_MS: envMs("POKER_TIMING_WINNER_POT_MS", 3000),
  /** Gap between the winner display and the start of the next hand. */
  NEXT_HAND_DELAY_MS: envMs("POKER_TIMING_NEXT_HAND_MS", 9000),
  RECONNECT_WINDOW_MS: envMs("POKER_RECONNECT_WINDOW_MS", 90000),
  /** Seat vacate grace period before a bot replaces the leaving player. */
  VACATE_WINDOW_MS: envMs("POKER_VACATE_WINDOW_MS", 30000),
  /**
   * How long a lone seated human waits for a real opponent before the table
   * fills with bots and starts. On a humans-only table nothing fills the seats,
   * so the window simply re-arms and the table stays in "waiting".
   */
  WAIT_FOR_PLAYERS_MS: envMs("POKER_WAIT_FOR_PLAYERS_MS", 15000),
  /**
   * How long an empty-table reset waits for an in-flight hand before deferring.
   * Deliberately short: the reset is awaited inline on the leaving player's
   * request, and a showdown tail holds the action lock for ~10s. Deferring is
   * cheap — the table has no humans left by then, and beginNextHandIfPossible
   * retries the reset as soon as the hand finishes.
   */
  RESET_LOCK_WAIT_MS: envMs("POKER_TIMING_RESET_LOCK_WAIT_MS", 500),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

module.exports = { POKER_TIMINGS, sleep };
