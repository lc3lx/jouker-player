const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const HandHistory = require("../models/handHistoryModel");
const Table = require("../models/tableModel");
const PokerHandCommit = require("../models/pokerHandCommitModel");
const { verifyRecordedPokerHand } = require("../utils/poker/fairnessVerifier");
const { newDeck, shuffleDeterministic } = require("../utils/poker/deck");
const { buildDeckCommitment, proofForCard } = require("../utils/poker/fairnessCommitment");

/**
 * Privacy-preserving Fair Play view. A participant may verify that their own
 * hole cards and the public board were committed before the deal, but never
 * receives a seed that can reconstruct folded opponents' cards.
 */
exports.getFairPlayLastHand = asyncHandler(async (req, res, next) => {
  const tableId = req.params.id;
  const table = await Table.findById(tableId).select("_id");
  if (!table) return next(new ApiError("Table not found", 404));

  // Do not use "currently seated" as authorization: that lets a player who
  // joined after a hand obtain its verification material.
  const hand = await HandHistory.findOne({
    table: tableId,
    "players.user": req.user._id,
  })
    .sort({ endedAt: -1 })
    .select("handId community pot provablyFair endedAt startedAt seats dealtSeatIndices")
    .lean();

  if (!hand) {
    return next(new ApiError("No completed hand for this player on this table", 403));
  }

  const commit = await PokerHandCommit.findOne({ handId: hand.handId })
    .select("handId table serverSeedHash clientSeedDigest deckCommitmentRoot issuedAt revealedAt")
    .lean();
  const replay = verifyRecordedPokerHand(hand);
  const commitMatches = !!commit &&
    String(commit.table) === String(tableId) &&
    commit.serverSeedHash === hand.provablyFair?.serverSeedHash &&
    commit.clientSeedDigest === hand.provablyFair?.clientSeedDigest &&
    commit.deckCommitmentRoot === hand.provablyFair?.deckCommitmentRoot &&
    new Date(commit.issuedAt).getTime() <= new Date(hand.endedAt).getTime();

  let cardProofs = { community: [], mine: [] };
  let deckCommitmentValid = false;
  if (replay.valid && hand.provablyFair?.serverSeed && hand.provablyFair?.handId) {
    const deck = shuffleDeterministic(
      newDeck(),
      `${hand.provablyFair.serverSeed}:${hand.provablyFair.clientSeedDigest}:${hand.provablyFair.handId}`
    );
    const drawOrder = [...deck].reverse();
    const root = buildDeckCommitment(hand.handId, drawOrder).root;
    deckCommitmentValid = root === hand.provablyFair.deckCommitmentRoot;
    if (deckCommitmentValid) {
      const uid = String(req.user._id);
      const mine = (hand.seats || []).find((seat) => String(seat?.user || "") === uid);
      cardProofs = {
        community: (hand.community || []).map((card) => proofForCard({ handId: hand.handId, drawOrder, card })),
        mine: (mine?.hole || []).map((card) => proofForCard({ handId: hand.handId, drawOrder, card })),
      };
    }
  }

  res.status(200).json({
    status: "success",
    data: {
      handId: hand.handId,
      community: hand.community || [],
      pot: hand.pot,
      endedAt: hand.endedAt,
      provablyFair: {
        handId: hand.handId,
        serverSeedHash: hand.provablyFair?.serverSeedHash || null,
        clientSeedDigest: hand.provablyFair?.clientSeedDigest || null,
        deckCommitmentRoot: hand.provablyFair?.deckCommitmentRoot || null,
      },
      cardProofs,
      verification: {
        valid: replay.valid && commitMatches && deckCommitmentValid,
        replayValid: replay.valid,
        commitmentValid: commitMatches,
        deckCommitmentValid,
        reason: !replay.valid
          ? replay.reason
          : (!commitMatches ? "COMMITMENT_MISMATCH" : (!deckCommitmentValid ? "DECK_COMMITMENT_MISMATCH" : null)),
        committedAt: commit?.issuedAt || null,
      },
    },
  });
});
