const { toSafeInt } = require("../pokerTableStatus");
const { sendAlert } = require("../alert");
const logger = require("../logger");
const { metrics } = require("../metrics");

/**
 * Strict chip conservation:
 * Total = sum(stacks) + sum(bets) + pot + uncollectedRake
 * Must equal handStartTotal (or invested baseline at street boundaries).
 *
 * @param {object} game — PokerTable instance
 * @param {string} context — audit label
 * @returns {{ ok: boolean, expected: number, actual: number, delta: number }}
 */
function auditChipConservation(game, context = "unknown") {
  const seats = Array.isArray(game.seats) ? game.seats : [];
  const pot = toSafeInt(game.pot, 0);
  const rakeAcc = toSafeInt(game.uncollectedRake, 0);

  let stacksAndBets = 0;
  for (const s of seats) {
    stacksAndBets += toSafeInt(s.chips, 0) + toSafeInt(s.bet, 0);
  }

  const actual = stacksAndBets + pot + rakeAcc;
  const expected = toSafeInt(game.handStartTotal, actual);
  const delta = actual - expected;

  return {
    ok: delta === 0,
    expected,
    actual,
    delta,
    context,
    pot,
    rakeAcc,
    stacksAndBets,
  };
}

/**
 * Run audit; on failure freeze table and halt game loop.
 * @returns {boolean} true if OK
 */
async function auditOrFreeze(game, context) {
  if (game.frozen) return false;

  const result = auditChipConservation(game, context);
  if (result.ok) return true;

  game.frozen = true;
  game.running = false;
  game.tableStatusOverride = "frozen";
  game.clearActionScheduling?.();
  game.clearTurnTimer?.();
  game.clearBotFillTimer?.();

  const payload = {
    tableId: game.tableId,
    handId: game.currentHandId,
    context,
    ...result,
  };

  logger.error("poker_chip_conservation_violation", payload);
  metrics.errorsTotal.inc({ type: "chip_conservation_violation" });
  void sendAlert("poker_table_frozen", payload);

  try {
    await game.broadcastState?.();
  } catch (_) {
    /* ignore broadcast errors during freeze */
  }

  return false;
}

module.exports = { auditChipConservation, auditOrFreeze };
