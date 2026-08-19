const mongoose = require("mongoose");

const seatSnapshotSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    name: { type: String },
    isBot: { type: Boolean, default: false },
    seatIndex: Number,
    chipsBefore: Number,
    chipsAfter: Number,
    net: Number,
    hole: [String],
    folded: { type: Boolean, default: false },
    won: { type: Boolean, default: false },
    handCategory: { type: String },
    result: { type: String },
  },
  { _id: false }
);

const handAuditEntrySchema = new mongoose.Schema(
  {
    ts: Number,
    round: String,
    type: String,
    playerId: String,
    seatIndex: Number,
    amount: Number,
    message: { type: String, required: true },
  },
  { _id: false }
);

const handActionSchema = new mongoose.Schema(
  {
    ts: Number,
    round: String,
    type: String,
    playerId: String,
    seatIndex: Number,
    amount: Number,
    callAmount: Number,
  },
  { _id: false }
);

const handPlayerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    seatIndex: Number,
    chipsBefore: Number,
    chipsAfter: Number,
  },
  { _id: false }
);

const handPotWinnerSchema = new mongoose.Schema(
  {
    playerId: String,
    amountWon: Number,
  },
  { _id: false }
);

const handPotDistributionSchema = new mongoose.Schema(
  {
    potId: Number,
    amount: Number,
    eligiblePlayers: [String],
    winners: [handPotWinnerSchema],
  },
  { _id: false }
);

const handHistorySchema = new mongoose.Schema(
  {
    // A hand settlement is a financial idempotency boundary. Keeping this as
    // a database-enforced unique value prevents a retry/failover from paying
    // the same hand twice.
    handId: { type: String, required: true, unique: true, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true },
    gameType: { type: String, enum: ["poker", "trix", "tarneeb41"], default: "poker", index: true },
    tableNumber: Number,
    dealerSeatIndex: Number,
    smallBlind: Number,
    bigBlind: Number,
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    durationMs: Number,
    players: [handPlayerSchema],
    actions: [handActionSchema],
    /** Human-readable chronological ledger for support / fraud analytics. */
    auditLog: [handAuditEntrySchema],
    community: [String],
    /** Engine seat order that received hole cards; required for fair replay. */
    dealtSeatIndices: [Number],
    pot: Number,
    /** Portion actually contested by two or more players; rake is based on this. */
    contestedPot: Number,
    /** Unmatched overbets returned to their owner, never treated as winnings. */
    uncalledReturns: [{
      seatIndex: Number,
      user: { type: mongoose.Schema.ObjectId, ref: "User" },
      amount: Number,
    }],
    rake: Number,
    winners: [{ user: { type: mongoose.Schema.ObjectId, ref: "User" }, share: Number }],
    handCategory: String,
    potDistribution: [handPotDistributionSchema],
    seats: [seatSnapshotSchema],
    /** Deterministic replay payload (streets + actions + stacks). */
    replayData: { type: mongoose.Schema.Types.Mixed },
    /** SHA-256 of canonical hand payload for dispute resolution. */
    auditHash: { type: String, index: true },
    screenshot: { type: mongoose.Schema.ObjectId, ref: "HandScreenshot" },
    /** Internal seed + public commitment material for later proof generation. */
    provablyFair: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

handHistorySchema.index({ table: 1, endedAt: -1, createdAt: -1 });

module.exports = mongoose.model("HandHistory", handHistorySchema);
