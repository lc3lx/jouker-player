const mongoose = require("mongoose");

const playerSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    displayName: {
      type: String,
      trim: true,
    },
    avatar: {
      type: String,
    },
    stats: {
      totalScore: { type: Number, default: 0 },
      bestScore: { type: Number, default: 0 },
      gamesPlayed: { type: Number, default: 0 },
      totalPlayTimeSec: { type: Number, default: 0 },
      level: { type: Number, default: 1 },
      experience: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
    },
    achievements: [
      {
        type: mongoose.Schema.ObjectId,
        ref: "Achievement",
      },
    ],
    inventory: [
      {
        item: { type: mongoose.Schema.ObjectId, ref: "GameItem" },
        quantity: { type: Number, default: 1 },
      },
    ],
    settings: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);

playerSchema.index({ "stats.totalScore": -1 });
playerSchema.index({ "stats.bestScore": -1 });

playerSchema.statics.getOrCreateByUser = async function (userId) {
  let player = await this.findOne({ user: userId });
  if (!player) {
    player = await this.create({ user: userId });
  }
  return player;
};

module.exports = mongoose.model("Player", playerSchema);
