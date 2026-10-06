"use strict";

/**
 * Poseidon settlement — the one place that turns an engine result into money
 * and bonus entitlement. Pure: no I/O, no randomness. poseidonService and the
 * economy simulator both call it, so the simulator measures exactly what the
 * server pays (the 2026-10 audit found a tool/production drift that hid a
 * 165% buy RTP).
 *
 * Amounts are bet multiples. `rules` comes from the session's economy profile
 * (v4+) or from the legacy constants (v1–v3).
 */

const constants = require("./constants");

/** Legacy rules: per-spin cap only, unlimited retriggers. */
const LEGACY_RULES = Object.freeze({
  maxWinX: constants.MAX_WIN_MULTIPLIER,
  roundCap: false,
  maxFreeSpins: Infinity,
  freeSpinsNatural: constants.FREE_SPINS_NATURAL,
  retriggerAward: constants.RETRIGGER_AWARD,
  triggerNaturalMin: constants.TRIGGER_NATURAL_MIN,
  triggerRetriggerMin: constants.TRIGGER_RETRIGGER_MIN,
});

function resolverFor(economyVersion) {
  return economyVersion === 1
    ? require("./constants.v1").resolvePayoutMultiplier
    : constants.resolvePayoutMultiplier;
}

/**
 * @param {object} args
 * @param {object} args.spin            engine result: baseWin, multiplierSum, scatterCount
 * @param {number} args.economyVersion  engine version that produced the spin
 * @param {object} [args.rules]         profile rules (v4+); legacy rules otherwise
 * @param {object|null} [args.session]  null for a paid spin, else
 *                                      { bonusMultiplier, roundWonX, freeSpinsRemaining }
 * @param {boolean} [args.canTrigger]   false when a bonus is already active
 */
function settleSpin({ spin, economyVersion, rules = LEGACY_RULES, session = null, canTrigger = true }) {
  const isFreeSpin = session != null;
  const carried = isFreeSpin ? Number(session.bonusMultiplier || 0) : 0;
  const plaqueSum = Math.max(0, Number(spin.multiplierSum) || 0);
  const { applied, nextCarried } = resolverFor(economyVersion)({
    baseWin: spin.baseWin,
    plaqueSum,
    carried,
    isFreeSpin,
    bankCap: Number.POSITIVE_INFINITY,
  });

  let winX = spin.baseWin * applied;
  const winCapped = winX > rules.maxWinX;
  if (winCapped) winX = rules.maxWinX;

  // Cumulative round cap (v4+): a bonus round never pays past maxWinX in total.
  let capReached = false;
  if (isFreeSpin && rules.roundCap) {
    const left = Math.max(0, rules.maxWinX - Number(session.roundWonX || 0));
    if (winX >= left) {
      winX = left;
      capReached = true;
    }
  }

  const scatterCount = Number.isFinite(spin.scatterCount)
    ? spin.scatterCount
    : (spin.scatters || []).length;
  let award = null;
  if (isFreeSpin) {
    if (!capReached && scatterCount >= rules.triggerRetriggerMin) {
      const room = Math.max(0, rules.maxFreeSpins - Number(session.freeSpinsRemaining || 0));
      const spins = Math.min(rules.retriggerAward, room);
      if (spins > 0) award = { type: "retrigger", spins };
    }
  } else if (canTrigger && scatterCount >= rules.triggerNaturalMin) {
    award = { type: "create", spins: rules.freeSpinsNatural };
  }

  return {
    applied,
    nextCarried,
    winX,
    winCapped: winCapped || capReached,
    capReached,
    scatterCount,
    award,
  };
}

module.exports = { settleSpin, LEGACY_RULES };
