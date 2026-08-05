const { newDeck, shuffleDeterministic, sha256Hex } = require("./deck");

function take(deck, count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) cards.push(deck.pop());
  return cards;
}

/** Replays this engine's documented deal/burn order from a settled hand. */
function verifyRecordedPokerHand(hand) {
  const fair = hand?.provablyFair;
  if (!fair?.serverSeed || !fair?.clientSeedDigest || !fair?.handId) {
    return { valid: false, reason: "MISSING_FAIRNESS_DATA" };
  }
  if (sha256Hex(fair.serverSeed) !== fair.serverSeedHash) {
    return { valid: false, reason: "SERVER_SEED_HASH_MISMATCH" };
  }

  const dealtSeatIndices = Array.isArray(hand.dealtSeatIndices)
    ? hand.dealtSeatIndices.map(Number).filter(Number.isInteger)
    : [];
  if (dealtSeatIndices.length === 0) {
    return { valid: false, reason: "MISSING_DEAL_ORDER" };
  }

  const deck = shuffleDeterministic(
    newDeck(),
    `${fair.serverSeed}:${fair.clientSeedDigest}:${fair.handId}`
  );
  const byIndex = new Map(
    (Array.isArray(hand.seats) ? hand.seats : []).map((seat, index) => [index, seat])
  );

  for (const seatIndex of dealtSeatIndices) {
    const expected = take(deck, 2);
    const actual = byIndex.get(seatIndex)?.hole;
    if (!Array.isArray(actual) || actual.length !== 2 || actual[0] !== expected[0] || actual[1] !== expected[1]) {
      return { valid: false, reason: "HOLE_CARD_MISMATCH", seatIndex };
    }
  }

  const actualCommunity = Array.isArray(hand.community) ? hand.community : [];
  if (![0, 3, 4, 5].includes(actualCommunity.length)) {
    return { valid: false, reason: "INVALID_COMMUNITY_LENGTH" };
  }
  take(deck, 1); // burn before flop
  const expectedCommunity = [...take(deck, 3)];
  take(deck, 1); // burn before turn
  expectedCommunity.push(...take(deck, 1));
  take(deck, 1); // burn before river
  expectedCommunity.push(...take(deck, 1));

  const expectedVisible = expectedCommunity.slice(0, actualCommunity.length);
  if (expectedVisible.join("|") !== actualCommunity.join("|")) {
    return { valid: false, reason: "COMMUNITY_CARD_MISMATCH" };
  }
  return { valid: true, reason: null };
}

module.exports = { verifyRecordedPokerHand };
