const mongoose = require("mongoose");

const islandMemberSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    active: { type: Boolean, default: true, index: true },
    joinedAt: { type: Date, default: Date.now },
    totalContributed: { type: Number, default: 0, min: 0 },
    winCount: { type: Number, default: 0, min: 0 },
    lastEntryTxnId: { type: String, default: "" },
  },
  { timestamps: true }
);

islandMemberSchema.index({ active: 1, joinedAt: -1 });
islandMemberSchema.index({ totalContributed: -1 });

module.exports = mongoose.model("IslandMember", islandMemberSchema);
