const { test } = require("node:test");
const assert = require("node:assert/strict");

const { newDeck, shuffleDeterministic, sha256Hex } = require("../utils/poker/deck");
const { verifyRecordedPokerHand } = require("../utils/poker/fairnessVerifier");
const {
  buildDeckCommitment,
  proofForCard,
  verifyCardProof,
} = require("../utils/poker/fairnessCommitment");

function take(deck, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(deck.pop());
  return out;
}

function sampleHand() {
  const serverSeed = "server-seed-for-test";
  const clientSeedDigest = sha256Hex("u1:client|u2:client");
  const handId = "fair-hand-1";
  const deck = shuffleDeterministic(newDeck(), `${serverSeed}:${clientSeedDigest}:${handId}`);
  const seats = [
    { hole: take(deck, 2) },
    { hole: take(deck, 2) },
  ];
  take(deck, 1);
  const community = take(deck, 3);
  take(deck, 1);
  community.push(...take(deck, 1));
  take(deck, 1);
  community.push(...take(deck, 1));
  return {
    handId,
    dealtSeatIndices: [0, 1],
    seats,
    community,
    provablyFair: {
      handId,
      serverSeed,
      serverSeedHash: sha256Hex(serverSeed),
      clientSeedDigest,
    },
  };
}

test("fairness verifier accepts the exact committed deal", () => {
  const result = verifyRecordedPokerHand(sampleHand());
  assert.deepEqual(result, { valid: true, reason: null });
});

test("fairness verifier rejects any changed community card", () => {
  const hand = sampleHand();
  hand.community[4] = hand.community[4] === "As" ? "Ks" : "As";
  assert.equal(verifyRecordedPokerHand(hand).reason, "COMMUNITY_CARD_MISMATCH");
});

test("Merkle card proofs validate only the committed public or private card", () => {
  const hand = sampleHand();
  const deck = shuffleDeterministic(
    newDeck(),
    `${hand.provablyFair.serverSeed}:${hand.provablyFair.clientSeedDigest}:${hand.handId}`
  );
  const drawOrder = [...deck].reverse();
  const commitment = buildDeckCommitment(hand.handId, drawOrder);
  const proof = proofForCard({
    handId: hand.handId,
    drawOrder,
    card: hand.community[0],
  });

  assert.equal(proof.root, commitment.root);
  assert.equal(verifyCardProof({ handId: hand.handId, ...proof }), true);
  assert.equal(
    verifyCardProof({ handId: hand.handId, ...proof, card: hand.community[1] }),
    false,
    "a proof cannot be reused for another card"
  );
});
