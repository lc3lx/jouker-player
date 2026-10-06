"use strict";

/**
 * Profile building blocks for the slot calibrator.
 *
 * `template(game)` is the fixed skeleton of a game's v4/v5/v3 economy (board
 * symbol mix, scheduled-event probabilities, rules) that calibration then
 * tunes. `legacyEquivalent(game)` reproduces today's production game inside
 * the new profile engine — the equivalence test uses it to prove the new
 * engines deal exactly the legacy game when given the legacy numbers.
 */

const path = require("node:path");

const BACKEND = path.join(__dirname, "../..");
const req = (rel) => require(path.join(BACKEND, rel));

const RULES = Object.freeze({
  poseidon: { triggerNaturalMin: 4, triggerRetriggerMin: 3 },
  zeus: { triggerNaturalMin: 4, triggerRetriggerMin: 3 },
  zenobia: { triggerNaturalMin: 3, triggerRetriggerMin: 2 },
});

function rules(game) {
  return {
    maxWinX: 5000,
    roundCap: true,
    maxFreeSpins: 50,
    freeSpinsNatural: 10,
    freeSpinsBought: 10,
    retriggerAward: 5,
    ...RULES[game],
  };
}

/** Power-law face distribution q_v ∝ v^-alpha over faces ≥ minFace, as weights summing to 1. */
function powerLawFaces(values, alpha, minFace = 0) {
  const raw = values.map((v) => (v >= minFace ? v ** -alpha : 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

function meanFace(values, q) {
  return values.reduce((sum, v, i) => sum + v * q[i], 0);
}

/** Absolute per-spin percentages for a one-plaque-per-spin engine. */
function perSpinPercents(q, presence) {
  return q.map((w) => Number((w * presence * 100).toFixed(9)));
}

function template(game) {
  if (game === "poseidon") {
    const c = req("games/poseidon/constants");
    return {
      game,
      economyVersion: 4,
      params: {
        symbols: {
          base: [["s", 11], ["n", 11], ["e", 11], ["a", 11], ["starfish", 9], ["coral", 9], ["fish", 7.5], ["crown", 5.5], ["pearl", 5]],
          bonus: [["s", 13], ["n", 13], ["e", 13], ["a", 13], ["starfish", 8], ["coral", 8], ["fish", 6], ["crown", 4.5], ["pearl", 4]],
        },
        headWeight: { base: 1.0, bonus: 1.7 },
        plaques: { values: [...c.MULTIPLIER_VALUES], base: [], bonus: [], super: [] },
        jackpot: { win: 0.0001, appearance: 0.18 },
        naturalBonusProbability: 0.004,
      },
      rules: rules(game),
      letters: ["s", "n", "e", "a"],
      superMinFace: 20,
    };
  }
  if (game === "zeus") {
    const e = req("games/dice/DiceEngine");
    return {
      game,
      economyVersion: 5,
      params: {
        symbols: { base: [8, 8, 8, 8, 8, 8, 8, 8], bonus: [...e.FREESPIN_WEIGHTS] },
        headWeight: { base: e.HEAD_WEIGHT_BASE, bonus: e.HEAD_WEIGHT_BONUS },
        plaques: { values: [...e.MULTIPLIER_VALUES], base: [], bonus: [], super: [] },
        jackpot: { win: 0.0001, appearance: 0.18 },
        naturalBonusProbability: 0.004,
      },
      rules: rules(game),
      letters: [0, 1, 2, 3],
      superMinFace: 20,
    };
  }
  if (game === "zenobia") {
    const c = req("games/zenobia/constants");
    const regular = (letters, mult) => [
      ["s", letters], ["n", letters], ["e", letters], ["a", letters],
      ["ring", 12], ["spear", 10], ["pot", 8], ["necklace", 6.5], ["throne", 5], ["queen", 4],
      ["mult", mult],
    ];
    return {
      game,
      economyVersion: 3,
      params: {
        symbols: { base: regular(22, 1.37), bonus: regular(22, 3.25), super: regular(20, 4.5) },
        scatterWeight: { base: 1.39, bonus: 1.01, super: 1.01 },
        jackpotWeight: { base: 0.3, bonus: 0.3, super: 0.3 },
        plaques: { values: [...c.MULTIPLIER_VALUES], base: [], bonus: [], super: [] },
        jackpot: { win: 0.0001 },
        naturalBonusProbability: 0.004,
      },
      rules: rules(game),
      letters: ["s", "n", "e", "a"],
      superMinFace: c.SUPER_MULTIPLIER_MIN,
    };
  }
  throw new Error(`unknown game ${game}`);
}

/** Scale the letter weights of a symbol table by k (concentration lever). */
function scaleLetters(game, table, letters, k) {
  if (game === "zeus") return table.map((w, i) => (letters.includes(i) ? Number((w * k).toFixed(6)) : w));
  return table.map(([s, w]) => [s, letters.includes(s) ? Number((w * k).toFixed(6)) : w]);
}

/** Today's production game expressed as a profile (equivalence tests only). */
function legacyEquivalent(game) {
  if (game === "poseidon") {
    const c = req("games/poseidon/constants");
    const t = template("poseidon");
    t.params.plaques = {
      values: [...c.MULTIPLIER_VALUES],
      base: [...c.BASE_MULTIPLIER_WEIGHTS],
      bonus: [...c.BONUS_MULTIPLIER_WEIGHTS],
      super: [...c.SUPER_MULTIPLIER_WEIGHTS],
    };
    t.params.jackpot = { win: c.JACKPOT_WIN_PROBABILITY, appearance: c.JACKPOT_APPEARANCE_PROBABILITY };
    t.params.naturalBonusProbability = c.NATURAL_BONUS_PROBABILITY;
    return { ...t, id: "poseidon-legacy-equivalent" };
  }
  if (game === "zeus") {
    const e = req("games/dice/DiceEngine");
    const t = template("zeus");
    t.params.symbols = { base: [...e.BASE_WEIGHTS], bonus: [...e.FREESPIN_WEIGHTS] };
    t.params.plaques = {
      values: [...e.MULTIPLIER_VALUES],
      base: [...e.BASE_MULTIPLIER_WEIGHTS],
      bonus: [...e.BONUS_MULTIPLIER_WEIGHTS],
      super: [...e.SUPER_MULTIPLIER_WEIGHTS],
    };
    t.params.jackpot = { win: e.JACKPOT_WIN_PROBABILITY, appearance: e.JACKPOT_APPEARANCE_PROBABILITY };
    t.params.naturalBonusProbability = e.NATURAL_BONUS_PROBABILITY;
    return { ...t, id: "zeus-legacy-equivalent" };
  }
  throw new Error(`no legacy-equivalent profile for ${game}`);
}

module.exports = { template, rules, powerLawFaces, meanFace, perSpinPercents, scaleLetters, legacyEquivalent };
