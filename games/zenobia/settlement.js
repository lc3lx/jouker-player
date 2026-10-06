"use strict";

/**
 * Zenobia settlement — turns an engine result into money and bonus
 * entitlement. Pure; shared by zenobiaService and the economy simulator so the
 * simulator measures exactly what the server pays. Amounts are bet multiples.
 */

const constants = require("./constants");

/** Legacy (v1/v2) rules: per-spin cap only, unlimited retriggers. */
const LEGACY_RULES = Object.freeze({
  maxWinX: constants.MAX_WIN_MULTIPLIER,
  roundCap: false,
  maxFreeSpins: Infinity,
  freeSpinsNatural: constants.FREE_SPINS_NATURAL,
  retriggerAward: constants.RETRIGGER_AWARD,
  triggerNaturalMin: constants.TRIGGER_NATURAL_MIN,
  triggerRetriggerMin: constants.TRIGGER_RETRIGGER_MIN,
});

/**
 * v3 Bonus Box rule — the one the paytable has always described: in free
 * spins the banked total multiplies a win only when that win brought a fresh
 * plaque; a win without one pays plain and the bank is kept.
 */
function resolveFreshPlaque({ baseWin = 0, plaqueSum = 0, carried = 0, isFreeSpin = false } = {}) {
  const won = Number(baseWin) > 0;
  const plaques = won ? Math.max(0, Number(plaqueSum) || 0) : 0;
  const prev = Math.max(0, Number(carried) || 0);
  const nextCarried = isFreeSpin ? prev + plaques : 0;
  const pool = isFreeSpin ? nextCarried : plaques;
  const applied = won && plaques > 0 && pool > 0 ? pool : 1;
  return { applied, nextCarried, plaques };
}

function resolverFor(economyVersion) {
  // v1/v2 sessions keep the rule they were sold with (bank applies to any win).
  return economyVersion >= 3 ? resolveFreshPlaque : constants.resolvePayoutMultiplier;
}

function settleSpin({ spin, economyVersion, rules = LEGACY_RULES, session = null, canTrigger = true }) {
  const isFreeSpin = session != null;
  const carried = isFreeSpin ? Number(session.bonusMultiplier || 0) : 0;
  const { applied, nextCarried } = resolverFor(economyVersion)({
    baseWin: spin.baseWin,
    plaqueSum: Math.max(0, Number(spin.multiplierSum) || 0),
    carried,
    isFreeSpin,
  });

  let winX = spin.baseWin * applied;
  const winCapped = winX > rules.maxWinX;
  if (winCapped) winX = rules.maxWinX;

  let capReached = false;
  if (isFreeSpin && rules.roundCap) {
    const left = Math.max(0, rules.maxWinX - Number(session.roundWonX || 0));
    if (winX >= left) {
      winX = left;
      capReached = true;
    }
  }

  const scatterCount = spin.scatterCount;
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

module.exports = { settleSpin, resolveFreshPlaque, LEGACY_RULES };
