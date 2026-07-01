const mongoose = require("mongoose");

const handScreenshotSchema = new mongoose.Schema(
  {
    handId: { type: String, required: true, index: true },
    handHistory: { type: mongoose.Schema.ObjectId, ref: "HandHistory" },
    table: { type: mongoose.Schema.ObjectId, ref: "Table", required: true, index: true },
    gameType: { type: String, enum: ["poker", "trix", "tarneeb41"], default: "poker" },
    storageProvider: { type: String, enum: ["local", "s3", "gcs"], default: "local" },
    storageKey: { type: String, required: true },
    publicUrl: { type: String },
    width: Number,
    height: Number,
    snapshotMeta: { type: mongoose.Schema.Types.Mixed },
    auditHash: { type: String, index: true },
  },
  { timestamps: true }
);

handScreenshotSchema.index({ handId: 1 }, { unique: true });

module.exports = mongoose.model("HandScreenshot", handScreenshotSchema);
