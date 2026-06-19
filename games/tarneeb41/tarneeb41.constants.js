/** Shared Tarneeb41 gameplay timing constants. */

function parseCountdownSeconds() {
  const n = parseInt(process.env.GAME_START_COUNTDOWN_SECONDS || "15", 10);
  if (!Number.isFinite(n) || n < 3) return 15;
  return Math.min(n, 60);
}

function parseTrickDisplayMs() {
  const n = parseInt(process.env.TRICK_DISPLAY_SECONDS || "4", 10);
  if (!Number.isFinite(n) || n < 1) return 4000;
  return Math.min(n, 15) * 1000;
}

module.exports = {
  GAME_START_COUNTDOWN_SECONDS: parseCountdownSeconds(),
  TRICK_DISPLAY_MS: parseTrickDisplayMs(),
};
