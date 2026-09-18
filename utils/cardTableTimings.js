/**
 * How long a card table holds a seat open for real players before it gives up
 * and fills the empty chairs with bots.
 *
 * Poker has had this for a while (`POKER_WAIT_FOR_PLAYERS_MS`); Trix and
 * Tarneeb did not. Trix dealt the moment the first player sat down — a player
 * who opened a table was in a hand against three bots before they could look
 * up — and Tarneeb only waited because the *client* ran a 30s timer and then
 * asked the server to fill. A client-side timer is not a rule: background the
 * app, lose the socket, or open the table on a second device and the wait is
 * whatever that client happened to decide.
 *
 * The window is now the server's, it is the same fifteen seconds everywhere,
 * and the client only displays it.
 */
function envMs(name, fallback) {
  const raw = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return raw;
}

/** Shared with poker's POKER_WAIT_FOR_PLAYERS_MS default on purpose. */
const WAIT_FOR_PLAYERS_MS = envMs("CARD_WAIT_FOR_PLAYERS_MS", 15000);

/**
 * Partner picking, before the deal (Tarneeb 41 and تركس شركة). One player names
 * the partner they want and that player accepts; the other two are partners by
 * what is left. Both steps are bounded so a silent table still gets a game.
 */
const PARTNER_CHOOSE_MS = envMs("CARD_PARTNER_CHOOSE_MS", 20000);
const PARTNER_ACCEPT_MS = envMs("CARD_PARTNER_ACCEPT_MS", 15000);

/** Seconds still to run on a window that ends at `until` (ms epoch). */
function remainingWaitSeconds(until) {
  if (!until) return 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

module.exports = {
  WAIT_FOR_PLAYERS_MS,
  PARTNER_CHOOSE_MS,
  PARTNER_ACCEPT_MS,
  remainingWaitSeconds,
};
