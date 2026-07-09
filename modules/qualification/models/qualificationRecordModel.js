const mongoose = require("mongoose");

const qualificationRecordSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    achievementKey: { type: String, required: true, index: true },
    requirements: { type: mongoose.Schema.Types.Mixed, default: {} },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    qualifiedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

qualificationRecordSchema.index(
  { userId: 1, achievementKey: 1 },
  { unique: true }
);

module.exports = mongoose.model("QualificationRecord", qualificationRecordSchema);
