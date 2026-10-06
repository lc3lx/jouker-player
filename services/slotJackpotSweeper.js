"use strict";

/**
 * Slot jackpot sweeper — guarantees every triggered jackpot is paid.
 *
 * A player who triggers the match-3 jackpot (Poseidon / Zeus / Zenobia /
 * Golden Tree) must reveal the cards and settle from the client. If they
 * disconnect, close the app or crash, the round used to sit unsettled until a
 * TTL index deleted it — prize lost. Now the server takes over once the reveal
 * deadline (`expiresAt`) passes: it reveals the remaining cards in index order
 * and settles through the same idempotent settlement the client uses.
 */

const logger = require("../utils/logger");
const jackpotService = require("../games/poseidon/jackpot/jackpotService");
const { settleJackpotRound } = require("../games/poseidon/jackpot/jackpotSettlement");

const SWEEP_INTERVAL_MS = 60 * 1000;

let timer = null;
let running = false;

/** Resolve one stale round: finish the reveal, then settle (idempotent). */
async function resolveRound({ roundId, userId, game }) {
  await jackpotService.autoRevealRound(roundId, userId);
  const settled = await settleJackpotRound(roundId, userId);
  logger.info("slot_jackpot_auto_resolved", {
    roundId,
    game,
    userId,
    prizeType: settled.prizeType,
    prizeAmount: settled.prizeAmount,
    alreadySettled: !!settled.alreadySettled,
  });
  return settled;
}

/** One pass over stale rounds. Returns { claimed, resolved, failed }. */
async function sweepOnce({ now = Date.now() } = {}) {
  if (running) return { claimed: 0, resolved: 0, failed: 0, skipped: true };
  running = true;
  try {
    const stale = await jackpotService.claimStaleRounds({ now });
    let resolved = 0;
    let failed = 0;
    for (const round of stale) {
      try {
        await resolveRound(round);
        resolved += 1;
      } catch (err) {
        failed += 1;
        logger.error("slot_jackpot_auto_resolve_failed", {
          roundId: round.roundId,
          game: round.game,
          reason: err?.message || String(err),
        });
      }
    }
    return { claimed: stale.length, resolved, failed };
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => {
    sweepOnce().catch((err) => {
      logger.error("slot_jackpot_sweep_failed", { reason: err?.message || String(err) });
    });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, sweepOnce, resolveRound, SWEEP_INTERVAL_MS };
