const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  sessionId: { type: String, required: true },
  betAmount: { type: Number, required: true },
  freeSpinsRemaining: { type: Number, required: true },
  bonusType: String,
  resolvedType: String,
  gambleLocked: Boolean,
  totalWon: { type: Number, default: 0 },
  economyVersion: { type: Number, default: 1 },
  revision: { type: Number, default: 0 },
  createdAt: Number,
  updatedAt: Number,
}, { collection: "golden_tree_bonus_sessions" });
module.exports = mongoose.model("GoldenTreeBonusSession", schema);
