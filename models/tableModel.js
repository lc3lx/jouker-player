const mongoose = require("mongoose");

const seatSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    chips: { type: Number, required: true, min: 0 },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const waitingQueueEntrySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    buyIn: { type: Number, required: true, min: 0 },
    queuedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** Poker: human left seat — chips held until vacateUntil, then bot or restore. */
const vacatingPlayerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    chips: { type: Number, required: true, min: 0 },
    vacatedAt: { type: Date, default: Date.now },
    vacateUntil: { type: Date, required: true },
  },
  { _id: false }
);

const tableSchema = new mongoose.Schema(
  {
    gameType: {
      type: String,
      enum: ["poker", "trix", "tarneeb41"],
      default: "poker",
      index: true,
    },
    tier: { type: String, enum: ["beginner", "intermediate", "beast", "private"], required: true },
    tableNumber: { type: Number, required: true, index: true },
    smallBlind: { type: Number, required: true, min: 0 },
    bigBlind: { type: Number, required: true, min: 0 },
    minBuyIn: { type: Number, required: true, min: 0 },
    maxBuyIn: { type: Number, required: true, min: 0 },
    capacity: { type: Number, default: 9, min: 2, max: 9 },
    seats: [seatSchema],
    /** FIFO waiting list when all seats are taken (poker). */
    waitingQueue: { type: [waitingQueueEntrySchema], default: [] },
    /** Humans who vacated a seat — 30s window to return before a bot takes chips. */
    vacatingPlayers: { type: [vacatingPlayerSchema], default: [] },
    isPrivate: { type: Boolean, default: false },
    password: { type: String },
    status: {
      type: String,
      enum: ["waiting", "ready", "playing", "full", "frozen", "open", "closed", "archived"],
      default: "waiting",
      index: true,
    },
    /** Set while a game settlement is pending — blocks leaveTable cashout races */
    activeSettlementId: { type: String, default: null, index: true },
  },
  { timestamps: true }
);

tableSchema.index({ gameType: 1, tier: 1, tableNumber: 1 }, { unique: true });

tableSchema.pre("save", function capSeatsOnSave(next) {
  if (this.gameType === "poker") {
    this.capacity = Math.min(9, Math.max(2, Number(this.capacity) || 9));
    if (Array.isArray(this.seats) && this.seats.length > this.capacity) {
      return next(new Error("TABLE_CAPACITY_EXCEEDED"));
    }
  }
  next();
});

module.exports = mongoose.model("Table", tableSchema);
