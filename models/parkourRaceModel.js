const mongoose = require("mongoose");

const VALID_STATES = [
  "waiting",
  "countdown",
  "starting",
  "playing",
  "finished",
  "settlement_pending",
  "settled",
];

const participantSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    displayName: { type: String },
    seatIndex: { type: Number, required: true },
    buyIn: { type: Number, required: true, min: 0 },
    ready: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["active", "disconnected", "forfeited", "finished"],
      default: "active",
    },
    lastCheckpoint: { type: Number, default: -1 },
    checkpointsReached: [{ type: Number }],
    finishOrder: { type: Number, default: null },
    finishTimeMs: { type: Number, default: null },
    lastPosition: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
      z: { type: Number, default: 0 },
      t: { type: Number, default: 0 },
    },
    disconnectedAt: { type: Date },
    socketId: { type: String },
  },
  { _id: false }
);

const parkourRaceSchema = new mongoose.Schema(
  {
    raceId: { type: String, required: true, unique: true, index: true },
    trackId: { type: String, required: true, index: true },
    state: {
      type: String,
      enum: VALID_STATES,
      default: "waiting",
      index: true,
    },
    entryFee: { type: Number, required: true, min: 0 },
    minPlayers: { type: Number, default: 2, min: 2 },
    maxPlayers: { type: Number, default: 20, min: 2, max: 20 },
    participants: [participantSchema],
    sessionId: { type: String, index: true },
    countdownStartedAt: { type: Date },
    raceStartedAt: { type: Date },
    raceEndedAt: { type: Date },
    activeSettlementId: { type: String, default: null },
    settlementStatus: {
      type: String,
      enum: ["none", "pending", "completed", "failed"],
      default: "none",
    },
    finishedCount: { type: Number, default: 0 },
    nextFinishOrder: { type: Number, default: 1 },
    eventNonces: [{ type: String }],
  },
  { timestamps: true }
);

parkourRaceSchema.index({ state: 1, updatedAt: -1 });
parkourRaceSchema.index({ "participants.userId": 1, state: 1 });

parkourRaceSchema.statics.VALID_STATES = VALID_STATES;

module.exports = mongoose.model("ParkourRace", parkourRaceSchema);
