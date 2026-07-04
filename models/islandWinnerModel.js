const mongoose = require("mongoose");

const islandWinnerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, default: "" },
    handId: { type: String, required: true, index: true },
    handType: {
      type: String,
      enum: ["royalFlush", "straightFlush", "fourOfAKind"],
      required: true,
      index: true,
    },
    payoutAmount: { type: Number, required: true, min: 0 },
    poolBefore: { type: Number, default: 0 },
    poolAfter: { type: Number, default: 0 },
    percentage: { type: Number, default: 0 },
    tableId: { type: String, default: "", index: true },
    holeCards: [{ type: String }],
    communityCards: [{ type: String }],
    verifiedRank: {
      cat: { type: Number },
      tiebreak: [{ type: Number }],
    },
  },
  { timestamps: true }
);

islandWinnerSchema.index({ handId: 1, userId: 1 }, { unique: true });
islandWinnerSchema.index({ payoutAmount: -1 });
islandWinnerSchema.index({ createdAt: -1 });

module.exports = mongoose.model("IslandWinner", islandWinnerSchema);
