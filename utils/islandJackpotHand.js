const { bestOf7 } = require("./poker/handEval");

/** @typedef {"royalFlush"|"straightFlush"|"fourOfAKind"} IslandHandType */

const HAND_RANK = {
  royalFlush: 3,
  straightFlush: 2,
  fourOfAKind: 1,
};

const HAND_LABEL_AR = {
  royalFlush: "Royal Flush",
  straightFlush: "Straight Flush",
  fourOfAKind: "Four of a Kind",
};

/**
 * Classify a 7-card rank into island jackpot tiers (server-only).
 * @param {{ cat: number, tiebreak?: number[] }|null|undefined} rank
 * @returns {IslandHandType|null}
 */
function classifyIslandHand(rank) {
  if (!rank || !Number.isFinite(rank.cat)) return null;
  if (rank.cat === 8) {
    const isRoyal = Array.isArray(rank.tiebreak) && rank.tiebreak[0] === 14;
    return isRoyal ? "royalFlush" : "straightFlush";
  }
  if (rank.cat === 7) return "fourOfAKind";
  return null;
}

/**
 * Evaluate hole + community and return island tier.
 * @param {string[]} hole
 * @param {string[]} community
 * @returns {{ handType: IslandHandType, rank: object }|null}
 */
function evaluateIslandHand(hole, community) {
  if (!Array.isArray(hole) || hole.length < 2) return null;
  if (!Array.isArray(community) || community.length < 3) return null;
  const cards7 = [...hole.slice(0, 2), ...community.slice(0, 5)];
  if (cards7.length < 7) return null;
  const rank = bestOf7(cards7);
  const handType = classifyIslandHand(rank);
  if (!handType) return null;
  return { handType, rank };
}

function compareHandTypes(a, b) {
  return (HAND_RANK[a] || 0) - (HAND_RANK[b] || 0);
}

function handTypeLabel(handType) {
  return HAND_LABEL_AR[handType] || handType;
}

module.exports = {
  HAND_RANK,
  HAND_LABEL_AR,
  classifyIslandHand,
  evaluateIslandHand,
  compareHandTypes,
  handTypeLabel,
};
