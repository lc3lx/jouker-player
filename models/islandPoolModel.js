const mongoose = require("mongoose");

const payoutPercentagesSchema = new mongoose.Schema(
  {
    royalFlush: { type: Number, default: 0.8, min: 0, max: 1 },
    straightFlush: { type: Number, default: 0.3, min: 0, max: 1 },
    fourOfAKind: { type: Number, default: 0.2, min: 0, max: 1 },
  },
  { _id: false }
);

const payoutPolicySchema = new mongoose.Schema(
  {
    maxWinnersPerEvent: { type: Number, default: 1, min: 1, max: 2 },
    requireShowdown: { type: Boolean, default: true },
    partialPoolRetention: { type: Boolean, default: true },
  },
  { _id: false }
);

const lastWinnerSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.ObjectId, ref: "User" },
    userName: { type: String, default: "" },
    amount: { type: Number, default: 0 },
    handType: { type: String, default: "" },
    handId: { type: String, default: "" },
    at: { type: Date },
  },
  { _id: false }
);

const statsSchema = new mongoose.Schema(
  {
    totalEntries: { type: Number, default: 0 },
    totalPaidOut: { type: Number, default: 0 },
    peakPoolBalance: { type: Number, default: 0 },
    totalWinners: { type: Number, default: 0 },
  },
  { _id: false }
);

const settingsSchema = new mongoose.Schema(
  {
    effectsEnabled: { type: Boolean, default: true },
    announcementsEnabled: { type: Boolean, default: true },
    /** Visual hot threshold — defaults to minTriggerAmount when null/0 */
    hotJackpotThreshold: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const islandPoolSchema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, index: true },
    enabled: { type: Boolean, default: true },
    poolBalance: { type: Number, default: 0, min: 0 },
    minTriggerAmount: { type: Number, default: 100_000_000, min: 0 },
    entryFee: { type: Number, default: 50_000, min: 0 },
    payoutPercentages: { type: payoutPercentagesSchema, default: () => ({}) },
    payoutPolicy: { type: payoutPolicySchema, default: () => ({}) },
    armed: { type: Boolean, default: false },
    hotJackpot: { type: Boolean, default: false },
    version: { type: Number, default: 0 },
    stats: { type: statsSchema, default: () => ({}) },
    settings: { type: settingsSchema, default: () => ({}) },
    lastWinner: lastWinnerSchema,
  },
  { timestamps: true }
);

islandPoolSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ key: "default" });
  if (!doc) {
    doc = await this.create({ key: "default" });
  }
  return doc;
};

module.exports = mongoose.model("IslandPool", islandPoolSchema);
