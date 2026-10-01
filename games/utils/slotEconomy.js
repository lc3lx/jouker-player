"use strict";

const VERSION = 2;
const BONUS_RTP = 0.46;
const scales = require("./slotEconomyCalibration.json");
const HIGH_PROBABILITIES = Object.freeze({ 20: 10, 50: 5, 100: 2, 200: 1, 500: 0.5, 1000: 0.1 });
const SUPER_VALUES = Object.freeze([20, 50, 100, 200, 500, 1000, null]);
const SUPER_WEIGHTS = Object.freeze([20, 5, 1, 0.5, 0.1, 0.02, 73.38]);

function faceWeights(values, previous) {
  const rest = values.reduce((n, v, i) => n + (HIGH_PROBABILITIES[v] == null ? previous[i] : 0), 0);
  return values.map((v, i) => HIGH_PROBABILITIES[v] ?? (81.4 * previous[i] / rest));
}

function pick(values, weights, rng) {
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < values.length; i++) {
    roll -= weights[i];
    if (roll < 0) return values[i];
  }
  return values[values.length - 1];
}

function pickFace(values, previous, { rng, superBonus = false } = {}) {
  return superBonus ? pick(SUPER_VALUES, SUPER_WEIGHTS, rng) : pick(values, faceWeights(values, previous), rng);
}

function payScale(game, { bonusMode = false, superBonus = false, tierName = "default", economyVersion = VERSION } = {}) {
  if (economyVersion === 1) return 1;
  const profile = scales[game];
  return bonusMode ? profile[superBonus ? "super" : "bonus"] : (profile.base[tierName] ?? profile.base.default);
}

module.exports = { VERSION, BONUS_RTP, HIGH_PROBABILITIES, SUPER_VALUES, SUPER_WEIGHTS, faceWeights, pickFace, payScale };
