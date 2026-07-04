const mongoose = require("mongoose");

const islandHistorySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["join", "payout", "admin_adjust", "hot_entered"],
      required: true,
      index: true,
    },
    userId: { type: mongoose.Schema.ObjectId, ref: "User", index: true },
    amount: { type: Number, default: 0 },
    poolAfter: { type: Number, default: 0 },
    handId: { type: String, default: "", index: true },
    handType: { type: String, default: "" },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

islandHistorySchema.index({ createdAt: -1 });
islandHistorySchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("IslandHistory", islandHistorySchema);
