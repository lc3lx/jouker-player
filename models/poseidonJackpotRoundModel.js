/**
 * Poseidon Jackpot Round — durable record of every jackpot scratch-card
 * mini-game. One document per triggered round.
 *
 * Lifecycle:  pending → scratching → revealed → settled | expired
 */

const mongoose = require("mongoose");

const cardSchema = new mongoose.Schema(
  {
    index:  { type: Number, required: true, min: 0, max: 8 },
    prize:  { type: String, required: true },
    amount: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const poseidonJackpotRoundSchema = new mongoose.Schema(
  {
    /** Stable UUID for this round — used as the idempotency key everywhere. */
    roundId: { type: String, required: true, unique: true, index: true },

    /** The spin result that triggered this jackpot round. */
    spinId: { type: String, required: true, index: true },

    /** Player who triggered the round. */
    userId: { type: String, required: true, index: true },

    /** Owning game: poseidon | king-arth | golden-tree (shared match-3). */
    game: {
      type: String,
      enum: ["poseidon", "king-arth", "golden-tree", "zenobia"],
      default: "poseidon",
      index: true,
    },

    /** Server-determined prize type: "no_win" | "super10m" | "mega50m" | "grand100m". */
    prizeType: { type: String, required: true },

    /** Economy context of the spin that triggered the round (stats only). */
    profileId: { type: String, default: null },
    economyVersion: { type: Number, default: null },
    /** paid | natural | buy | super — the kind of spin that triggered it. */
    origin: { type: String, default: null },

    /** Optional on legacy rounds; new rounds snapshot their validated base bet. */
    betAmount: { type: Number, min: 0 },
    payoutVersion: { type: Number },

    /** Prize amount in integer coins (0 for no_win). */
    prizeAmount: { type: Number, required: true, min: 0, default: 0 },

    /** Full 9-card layout, server-generated and immutable after creation. */
    cards: { type: [cardSchema], required: true },

    /** Indices of cards the player has revealed so far. */
    revealedCards: { type: [Number], default: [] },

    /** Round lifecycle status. */
    status: {
      type: String,
      enum: ["pending", "scratching", "revealed", "settled", "expired"],
      default: "pending",
      index: true,
    },

    /** WalletTransaction.id written on settlement (idempotency reference). */
    settlementId: { type: String, default: null },

    /** ISO timestamp when all cards were revealed (client acknowledged). */
    revealedAt: { type: Date, default: null },

    /** ISO timestamp when the wallet credit was committed. */
    settledAt:  { type: Date, default: null },

    /**
     * Reveal deadline. A round still unsettled past this point is resolved by
     * the server (services/slotJackpotSweeper.js) — it is never deleted
     * unpaid. (This used to carry a TTL index that silently deleted prizes.)
     */
    expiresAt: { type: Date, required: true },

    /** Cross-instance claim held by the sweeper while it resolves the round. */
    sweepLeaseUntil: { type: Date, default: null },

    /** Set only once the round is settled; the record is purged after that. */
    purgeAt: { type: Date, default: null, index: { expireAfterSeconds: 0 } },
  },
  {
    timestamps: true,
    collection: "poseidon_jackpot_rounds",
  }
);

// Fast lookup: active rounds for a player
poseidonJackpotRoundSchema.index({ userId: 1, status: 1 });
// Sweeper scan: unsettled rounds past their reveal deadline
poseidonJackpotRoundSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("PoseidonJackpotRound", poseidonJackpotRoundSchema);
