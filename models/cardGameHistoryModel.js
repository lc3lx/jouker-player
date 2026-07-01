const mongoose = require("mongoose");

const cardGameHistorySchema = new mongoose.Schema(
  {
    sessionId: { type: String, index: true },
    gameType: { type: String, enum: ["trix", "tarneeb41"], required: true, index: true },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true, index: true },
    tableNumber: Number,
    players: [{ type: mongoose.Schema.Types.Mixed }],
    rounds: [{ type: mongoose.Schema.Types.Mixed }],
    actions: [{ type: mongoose.Schema.Types.Mixed }],
    gameResult: { type: mongoose.Schema.Types.Mixed },
    settlementId: String,
    settlementSummary: { type: mongoose.Schema.Types.Mixed },
    replayData: { type: mongoose.Schema.Types.Mixed },
    auditHash: { type: String, index: true },
    screenshot: { type: mongoose.Schema.ObjectId, ref: "HandScreenshot" },
    evidence: { type: mongoose.Schema.ObjectId, ref: "HandEvidence" },
    durationMs: Number,
    startedAt: Date,
    endedAt: { type: Date, index: true },
    serverVersion: { type: String, default: process.env.APP_VERSION || "1.0.0" },
    rulesVersion: { type: String, default: process.env.RULES_VERSION || "1.0.0" },
    searchableText: { type: String, index: "text" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CardGameHistory", cardGameHistorySchema);
