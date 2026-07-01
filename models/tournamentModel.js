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
    lifecycle: {
      type: String,
      enum: [
        "scheduled",
        "registering",
        "late_registration",
        "running",
        "breaking",
        "balancing",
        "final_table",
        "finished",
      ],
      default: "registering",
      index: true,
    },
    tournamentType: {
      type: String,
      enum: [
        "sitngo",
        "scheduled",
        "mtt",
        "satellite",
        "freeroll",
        "private",
        "knockout",
        "pko",
        "progressive_knockout",
        "bounty",
      ],
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
      startingChips: { type: Number, default: 10000 },
      addonChips: { type: Number, default: 5000 },
      rebuyAllowed: { type: Boolean, default: false },
      addonAllowed: { type: Boolean, default: false },
      rebuyLevels: { type: Number, default: 3 },
      satelliteTargetId: { type: mongoose.Schema.ObjectId, ref: "Tournament" },
    },
    participants: [
      {
        user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
        player: { type: mongoose.Schema.ObjectId, ref: "Player" },
        country: { type: String, uppercase: true, trim: true },
        registeredAt: { type: Date, default: Date.now },
        chips: { type: Number, default: 10000 },
        eliminated: { type: Boolean, default: false },
        eliminatedAt: Date,
        finishPlace: Number,
        rebuys: { type: Number, default: 0 },
        addons: { type: Number, default: 0 },
        bounty: { type: Number, default: 0 },
        bountyPaid: { type: Number, default: 0 },
      },
    ],
    tables: [{ type: mongoose.Schema.Types.Mixed }],
    eliminated: [{ type: mongoose.Schema.Types.Mixed }],
    currentBlindLevel: { type: Number, default: 1 },
    currentBlinds: { type: mongoose.Schema.Types.Mixed },
    prizePool: { type: Number, default: 0 },
    prizes: [{ type: mongoose.Schema.Types.Mixed }],
    statistics: { type: mongoose.Schema.Types.Mixed },
    startedAt: Date,
    finishedAt: Date,
    lateRegistrationEndsAt: Date,
    breakEndsAt: Date,
    isHeadsUp: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Tournament", tournamentSchema);
