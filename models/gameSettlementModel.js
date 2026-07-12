const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User" },
    seatIndex: { type: Number, required: true },
    buyIn: { type: Number, required: true, min: 0 },
    payout: { type: Number, default: 0, min: 0 },
    netDelta: { type: Number, default: 0 },
    rakeShare: { type: Number, default: 0, min: 0 },
    isWinner: { type: Boolean, default: false },
    isBot: { type: Boolean, default: false },
    /** Human who vacated this seat mid-game (bot played it out) — lock forfeited at settlement. */
    vacatedUserId: { type: mongoose.Schema.ObjectId, ref: "User" },
  },
  { _id: false }
);

const reconciliationSchema = new mongoose.Schema(
  {
    totalBuyIns: { type: Number, required: true, min: 0 },
    totalHumanBuyIns: { type: Number, min: 0 },
    winnersPayouts: { type: Number, required: true, min: 0 },
    rake: { type: Number, required: true, min: 0 },
    houseNetDelta: { type: Number, default: 0 },
    humanNetDelta: { type: Number, default: 0 },
    balanced: { type: Boolean, required: true },
    delta: { type: Number, default: 0 },
  },
  { _id: false }
);

const gameSettlementSchema = new mongoose.Schema(
  {
    settlementId: { type: String, required: true, unique: true, index: true },
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    gameType: {
      type: String,
      enum: ["poker", "trix", "tarneeb41", "tournament", "parkour"],
      required: true,
      index: true,
    },
    tableId: { type: mongoose.Schema.ObjectId, ref: "Table", required: true, index: true },
    sessionId: { type: String, index: true },
    settlementStatus: {
      type: String,
      enum: ["pending", "completed", "failed", "skipped"],
      default: "pending",
      index: true,
    },
    settledAt: { type: Date, index: true },
    rakePercent: { type: Number, required: true, min: 0, max: 100 },
    totalBuyIn: { type: Number, required: true, min: 0 },
    totalHumanBuyIn: { type: Number, min: 0, default: 0 },
    totalBotBuyIn: { type: Number, min: 0, default: 0 },
    totalRake: { type: Number, required: true, min: 0 },
    totalPayout: { type: Number, required: true, min: 0 },
    totalHumanPayout: { type: Number, min: 0, default: 0 },
    totalBotPayout: { type: Number, min: 0, default: 0 },
    houseNetDelta: { type: Number, default: 0 },
    participants: [participantSchema],
    winners: [
      {
        userId: { type: mongoose.Schema.ObjectId, ref: "User" },
        seatIndex: { type: Number },
        payout: { type: Number, min: 0 },
        isBot: { type: Boolean, default: false },
      },
    ],
    reconciliation: reconciliationSchema,
    gameResult: { type: mongoose.Schema.Types.Mixed },
    errorMessage: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

gameSettlementSchema.index({ gameType: 1, settledAt: -1 });
gameSettlementSchema.index({ "participants.userId": 1, settledAt: -1 });

module.exports = mongoose.model("GameSettlement", gameSettlementSchema);
