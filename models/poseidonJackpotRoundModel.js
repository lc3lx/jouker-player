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

    /** Owning game: poseidon | king-arth (shared match-3 scratch rounds). */
    game: {
      type: String,
      enum: ["poseidon", "king-arth"],
      default: "poseidon",
      index: true,
    },

    /** Server-determined prize type: "no_win" | "super10m" | "mega50m" | "grand100m". */
    prizeType: { type: String, required: true },

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

    /** Expiry — if not settled by this time the round is expired. */
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  {
    timestamps: true,
    collection: "poseidon_jackpot_rounds",
  }
);

// Fast lookup: active rounds for a player
poseidonJackpotRoundSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model("PoseidonJackpotRound", poseidonJackpotRoundSchema);
