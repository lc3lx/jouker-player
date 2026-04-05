const mongoose = require("mongoose");

const lastWinSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User" },
    amount: { type: Number, default: 0 },
    handType: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const jackpotSchema = new mongoose.Schema(
  {
    pot: { type: Number, default: 0, min: 0 },
    contributionPerHand: { type: Number, default: 1, min: 0 },
    payouts: {
      royalFlush: { type: Number, default: 1.0 },
      straightFlush: { type: Number, default: 0.8 },
      fullHouse: { type: Number, default: 0.3 },
    },
    lastWin: lastWinSchema,
  },
  { timestamps: true }
);

jackpotSchema.statics.getSingleton = async function () {
  let j = await this.findOne();
  if (!j) j = await this.create({});
  return j;
};

module.exports = mongoose.model("Jackpot", jackpotSchema);
