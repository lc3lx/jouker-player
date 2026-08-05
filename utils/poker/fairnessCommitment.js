const { sha256Hex } = require("./deck");

/**
 * Privacy-preserving proof of a shuffled deck.
 *
 * A revealed server seed can reproduce every folded player's cards.  Instead,
 * commit to the draw-order with a Merkle root before dealing, then disclose a
 * proof only for public board cards and the requesting player's own cards.
 */
function leafHash({ handId, index, card }) {
  return sha256Hex(`poker-deck-v1|${String(handId)}|${Number(index)}|${String(card)}`);
}

function parentHash(left, right) {
  return sha256Hex(`poker-deck-v1|${left}|${right}`);
}

function buildLevels(handId, drawOrder) {
  if (!Array.isArray(drawOrder) || drawOrder.length !== 52) {
    throw new Error("FAIRNESS_DECK_ORDER_INVALID");
  }
  const levels = [drawOrder.map((card, index) => leafHash({ handId, index, card }))];
  while (levels[levels.length - 1].length > 1) {
    const previous = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < previous.length; i += 2) {
      // 52 is even at every level until the root, but duplicate defensively
      // so this remains correct should the deck shape ever change.
      next.push(parentHash(previous[i], previous[i + 1] || previous[i]));
    }
    levels.push(next);
  }
  return levels;
}

function buildDeckCommitment(handId, drawOrder) {
  const levels = buildLevels(handId, drawOrder);
  return { root: levels[levels.length - 1][0], levels };
}

function proofForCard({ handId, drawOrder, card }) {
  const index = drawOrder.indexOf(card);
  if (index < 0) throw new Error("FAIRNESS_CARD_NOT_IN_DECK");
  const { root, levels } = buildDeckCommitment(handId, drawOrder);
  let position = index;
  const proof = [];
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
    proof.push({
      hash: nodes[siblingIndex] || nodes[position],
      left: siblingIndex < position,
    });
    position = Math.floor(position / 2);
  }
  return { card, index, proof, root };
}

function verifyCardProof({ handId, card, index, proof, root }) {
  if (!Number.isInteger(index) || index < 0 || !Array.isArray(proof) || !root) return false;
  let current = leafHash({ handId, index, card });
  for (const step of proof) {
    if (!step || typeof step.hash !== "string") return false;
    current = step.left ? parentHash(step.hash, current) : parentHash(current, step.hash);
  }
  return current === root;
}

module.exports = {
  buildDeckCommitment,
  proofForCard,
  verifyCardProof,
};
