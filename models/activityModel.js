const mongoose = require("mongoose");

const activitySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["win", "loss", "task", "bonus", "tournament", "friend", "social", "other"],
      required: true,
      index: true,
    },
    label: { type: String, required: true },
    subLabel: { type: String, default: "" },
    amountDisplay: { type: String, default: "" },
    amountValue: { type: Number, default: 0 },
    icon: { type: String, default: "default" },
    sourceType: { type: String, default: "" },
    sourceId: { type: String, default: "", index: true },
    meta: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

activitySchema.index({ userId: 1, createdAt: -1 });
activitySchema.index({ userId: 1, category: 1, createdAt: -1 });
activitySchema.index({ userId: 1, sourceType: 1, sourceId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Activity", activitySchema);
