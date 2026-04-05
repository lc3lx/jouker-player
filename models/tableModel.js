const mongoose = require("mongoose");

const seatSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    chips: { type: Number, required: true, min: 0 },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const tableSchema = new mongoose.Schema(
  {
    gameType: {
      type: String,
      enum: ["poker", "trix", "tarneeb41"],
      default: "poker",
      index: true,
    },
    tier: { type: String, enum: ["beginner", "intermediate", "beast", "private"], required: true },
    tableNumber: { type: Number, required: true, index: true },
    smallBlind: { type: Number, required: true, min: 0 },
    bigBlind: { type: Number, required: true, min: 0 },
    minBuyIn: { type: Number, required: true, min: 0 },
    maxBuyIn: { type: Number, required: true, min: 0 },
    capacity: { type: Number, default: 9, min: 2, max: 10 },
    seats: [seatSchema],
    isPrivate: { type: Boolean, default: false },
    password: { type: String },
    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
  },
  { timestamps: true }
);

tableSchema.index({ gameType: 1, tier: 1, tableNumber: 1 }, { unique: true });

module.exports = mongoose.model("Table", tableSchema);
