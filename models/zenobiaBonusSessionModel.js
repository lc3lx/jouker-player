const mongoose = require("mongoose");

/**
 * Durable Zenobia free-spins / buy-bonus session.
 * Survives server restarts and client reconnects.
 *
 * `bonusMultiplier` is the Bonus Box total banked so far in this session — it
 * carries between free spins, so it has to be persisted alongside the count.
 */
const zenobiaBonusSessionSchema = new mongoose.Schema(
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
    bonusMultiplier: { type: Number, default: 0, min: 0 },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { collection: "zenobia_bonus_sessions" },
);

module.exports = mongoose.model(
  "ZenobiaBonusSession",
  zenobiaBonusSessionSchema,
);
