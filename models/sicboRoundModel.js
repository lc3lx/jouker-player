const mongoose = require("mongoose");

/**
 * SicBoRound — authoritative, persisted record of one global Sic Bo round.
 * MongoDB is the financial source of truth; Redis only caches this for fast reads.
 */
const sicboRoundSchema = new mongoose.Schema(
  {
    roundId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["BETTING", "LOCKED", "ROLLING", "RESULT", "SETTLED"],
      default: "BETTING",
      index: true,
    },

    bettingStart: { type: Date },
    bettingEnd: { type: Date }, // betting closes here
    resultAt: { type: Date }, // winners revealed here (= bettingEnd + rollMs)
    rolledAt: { type: Date }, // when the dice were actually generated
    settledAt: { type: Date },

    // Provably fair: hash published at open, seed revealed at result.
    serverSeed: { type: String },
    serverSeedHash: { type: String, required: true },
    clientSeed: { type: String, required: true },
    nonce: { type: String, required: true },

    dice1: { type: Number, min: 1, max: 6 },
    dice2: { type: Number, min: 1, max: 6 },
    dice3: { type: Number, min: 1, max: 6 },
    total: { type: Number, min: 3, max: 18 },
    /** big | small (or "triple" when a triple lands) */
    resultBigSmall: { type: String },
    resultOddEven: { type: String },
    isTriple: { type: Boolean, default: false },

    totalPlayers: { type: Number, default: 0, min: 0 },
    totalBets: { type: Number, default: 0, min: 0 },
    totalBetAmount: { type: Number, default: 0, min: 0 },
    totalPayout: { type: Number, default: 0, min: 0 },
    houseProfit: { type: Number, default: 0 },

    // Settlement progress (VERIFY COMPLETION step / stuck-round recovery).
    expectedSettlements: { type: Number, default: 0, min: 0 },
    settledCount: { type: Number, default: 0, min: 0 },
    settlementError: { type: String },
  },
  { timestamps: true }
);

sicboRoundSchema.index({ status: 1, createdAt: -1 });
sicboRoundSchema.index({ createdAt: -1 });

module.exports = mongoose.model("SicBoRound", sicboRoundSchema);
