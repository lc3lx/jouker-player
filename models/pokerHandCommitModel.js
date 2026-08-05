const mongoose = require("mongoose");

/**
 * Immutable-before-deal fairness commitment.  This is intentionally separate
 * from HandHistory: a hand history is created at settlement, which is too
 * late to prove that the seed was committed before cards were dealt.
 */
const pokerHandCommitSchema = new mongoose.Schema(
  {
    handId: { type: String, required: true, unique: true, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true, index: true },
    serverSeedHash: { type: String, required: true },
    clientSeedDigest: { type: String, required: true },
    /** Merkle root of the draw-order, committed before any card is dealt. */
    deckCommitmentRoot: { type: String, default: null },
    issuedAt: { type: Date, required: true, default: Date.now },
    revealedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

pokerHandCommitSchema.index({ table: 1, issuedAt: -1 });

module.exports = mongoose.model("PokerHandCommit", pokerHandCommitSchema);
