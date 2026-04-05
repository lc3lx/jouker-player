const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    player: { type: mongoose.Schema.ObjectId, ref: "Player" },
    country: { type: String, uppercase: true, trim: true },
    registeredAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const tournamentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    prize: { type: Number, required: true, min: 0 },
    entryFee: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, required: true, min: 1 },
    startAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["registering", "ongoing", "season", "history"],
      default: "registering",
      index: true,
    },
    participants: [participantSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Tournament", tournamentSchema);
