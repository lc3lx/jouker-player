const mongoose = require("mongoose");

const seatSnapshotSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    chipsBefore: Number,
    chipsAfter: Number,
    hole: [String],
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
    handId: { type: String, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    players: [handPlayerSchema],
    actions: [handActionSchema],
    /** Human-readable chronological ledger for support / fraud analytics. */
    auditLog: [handAuditEntrySchema],
    community: [String],
    pot: Number,
    rake: Number,
    winners: [{ user: { type: mongoose.Schema.ObjectId, ref: "User" }, share: Number }],
    handCategory: String,
    potDistribution: [handPotDistributionSchema],
    seats: [seatSnapshotSchema],
    /** Shown on Fair Play screen after hand ends (serverSeed revealed post-hand). */
    provablyFair: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HandHistory", handHistorySchema);
