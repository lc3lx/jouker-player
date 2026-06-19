const { toSafeInt } = require("../pokerTableStatus");

/**
 * Verify chips are conserved within a hand (stacks + table bets + pot).
 * @param {{ seats: Array, pot: number, handStartTotal?: number }} game
 * @returns {{ ok: boolean, expected: number, actual: number, delta: number }}
 */
function verifyHandChipConservation(game) {
  const seats = Array.isArray(game.seats) ? game.seats : [];
  const pot = toSafeInt(game.pot, 0);
  let stacksAndBets = 0;
  for (const s of seats) {
    stacksAndBets += toSafeInt(s.chips, 0) + toSafeInt(s.bet, 0);
  }
  const actual = stacksAndBets + pot;
  const expected =
    game.handStartTotal != null
      ? toSafeInt(game.handStartTotal, actual)
      : seats.reduce((sum, s) => sum + toSafeInt(s.handStartChips, toSafeInt(s.chips, 0)), 0);
  const delta = actual - expected;
  return { ok: delta === 0, expected, actual, delta };
}

/**
 * Table-level conservation including rake taken from payouts.
 * @param {{ seats: Array, pot: number, rake?: number }} input
 */
function verifyTableChipConservation(input) {
  const seats = Array.isArray(input.seats) ? input.seats : [];
  const pot = toSafeInt(input.pot, 0);
  const rake = toSafeInt(input.rake, 0);
  const chips = seats.reduce((sum, s) => sum + toSafeInt(s.chips, 0) + toSafeInt(s.bet, 0), 0);
  const invested = seats.reduce((sum, s) => sum + toSafeInt(s.invested, 0), 0);
  const actual = chips + pot;
  const expected = invested;
  const delta = actual + rake - expected;
  return { ok: delta === 0, expected, actual, rake, delta };
}

module.exports = { verifyHandChipConservation, verifyTableChipConservation };
