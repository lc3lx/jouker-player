const mongoose = require("mongoose");

const parkourResultSchema = new mongoose.Schema(
  {
    raceId: { type: String, required: true, index: true },
    raceMongoId: { type: mongoose.Schema.ObjectId, ref: "ParkourRace", index: true },
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    trackId: { type: String, required: true, index: true },
    finishOrder: { type: Number, default: null, index: true },
    finishTimeMs: { type: Number, default: null, index: true },
    checkpointsReached: { type: Number, default: 0 },
    entryFee: { type: Number, default: 0 },
    payout: { type: Number, default: 0 },
    netDelta: { type: Number, default: 0 },
    forfeited: { type: Boolean, default: false },
    won: { type: Boolean, default: false },
    settlementId: { type: String, index: true },
  },
  { timestamps: true }
);

parkourResultSchema.index({ userId: 1, finishTimeMs: 1 });
parkourResultSchema.index({ userId: 1, won: 1, createdAt: -1 });
parkourResultSchema.index({ trackId: 1, finishTimeMs: 1 });

module.exports = mongoose.model("ParkourResult", parkourResultSchema);
