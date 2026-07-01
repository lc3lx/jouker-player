const mongoose = require("mongoose");

const handEvidenceSchema = new mongoose.Schema(
  {
    handId: { type: String, required: true, unique: true, index: true },
    gameType: { type: String, enum: ["poker", "trix", "tarneeb41"], required: true, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", index: true },
    handHistory: { type: mongoose.Schema.ObjectId, ref: "HandHistory" },
    cardGameHistory: { type: mongoose.Schema.ObjectId, ref: "CardGameHistory" },
    replayData: { type: mongoose.Schema.Types.Mixed },
    settlementSummary: { type: mongoose.Schema.Types.Mixed },
    auditHash: { type: String, index: true },
    screenshot: { type: mongoose.Schema.ObjectId, ref: "HandScreenshot" },
    screenshotUrl: String,
    screenshotChecksum: String,
    serverVersion: { type: String, default: process.env.APP_VERSION || "1.0.0" },
    rulesVersion: { type: String, default: process.env.RULES_VERSION || "1.0.0" },
    players: [{ type: mongoose.Schema.Types.Mixed }],
    communityCards: [String],
    holeCardsByPlayer: { type: mongoose.Schema.Types.Mixed },
    winner: { type: mongoose.Schema.Types.Mixed },
    potDistribution: { type: mongoose.Schema.Types.Mixed },
    pot: Number,
    durationMs: Number,
    endedAt: { type: Date, index: true },
    searchableText: { type: String, index: "text" },
  },
  { timestamps: true }
);

handEvidenceSchema.index({ gameType: 1, endedAt: -1 });
handEvidenceSchema.index({ table: 1, endedAt: -1 });

module.exports = mongoose.model("HandEvidence", handEvidenceSchema);
