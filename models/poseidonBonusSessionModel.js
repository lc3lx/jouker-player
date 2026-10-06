const mongoose = require("mongoose");

/**
 * Durable Poseidon free-spins / buy-bonus session.
 * Survives server restarts and client reconnects.
 */
const poseidonBonusSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    sessionId: { type: String, required: true },
    betAmount: { type: Number, required: true, min: 0 },
    freeSpinsRemaining: { type: Number, required: true, min: 0 },
    totalWon: { type: Number, required: true, default: 0, min: 0 },
    economyVersion: { type: Number, default: 3 },
    revision: { type: Number, default: 0 },
    superBonus: { type: Boolean, default: false },
    bonusMultiplier: { type: Number, default: 0, min: 0 },
    /** Economy profile the session was sold/triggered under (v4+); null = legacy. */
    profileId: { type: String, default: null },
    /** natural | buy | super — what opened the session (stats + pricing audit). */
    origin: { type: String, enum: ["natural", "buy", "super", null], default: null },
    /** Coins paid for a bought session (0 for a natural trigger). */
    costPaid: { type: Number, default: 0, min: 0 },
    /** Bet multiples already paid this round, for the cumulative max-win cap. */
    roundWonX: { type: Number, default: 0, min: 0 },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "poseidon_bonus_sessions" },
);

module.exports = mongoose.model(
  "PoseidonBonusSession",
  poseidonBonusSessionSchema,
);
