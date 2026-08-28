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
    superBonus: { type: Boolean, default: false },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "poseidon_bonus_sessions" },
);

module.exports = mongoose.model(
  "PoseidonBonusSession",
  poseidonBonusSessionSchema,
);
