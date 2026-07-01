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
      enum: ["registering", "ongoing", "season", "history", "break", "final_table"],
      default: "registering",
      index: true,
    },
    tournamentType: {
      type: String,
      enum: ["sitngo", "scheduled", "mtt", "freeroll", "private", "knockout", "bounty"],
      default: "sitngo",
      index: true,
    },
    isPrivate: { type: Boolean, default: false },
    lateRegistrationMinutes: { type: Number, default: 0, min: 0 },
    blindSchedule: { type: [mongoose.Schema.Types.Mixed], default: [] },
    prizeDistribution: { type: [mongoose.Schema.Types.Mixed], default: [] },
    settings: {
      maxPlayers: { type: Number, default: 9 },
      minPlayers: { type: Number, default: 2 },
      breakEveryLevels: { type: Number, default: 0 },
      bountyAmount: { type: Number, default: 0 },
    },
    participants: [participantSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Tournament", tournamentSchema);
