const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    registeredAt: { type: Date, default: Date.now },
    seed: { type: Number, default: 0 },
    eliminated: { type: Boolean, default: false },
    finishPlace: { type: Number, default: null },
    /** Entry fee held in escrow for this participant (paid tournaments). */
    escrow: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const prizeSlotSchema = new mongoose.Schema(
  {
    place: { type: Number, required: true, min: 1 },
    /** Percentage of the prize pool (0–100). Amounts are derived at payout time. */
    percent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

/**
 * A clan-private tournament, game-agnostic across poker/trix/tarneeb41. The actual
 * matches live in the ClanTournamentMatch collection; this doc holds registration,
 * bracket shape, escrow and prize config. Driven by clanTournamentEngineService.
 */
const clanTournamentSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    game: { type: String, enum: ["poker", "trix", "tarneeb41"], required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, default: "", maxlength: 500, trim: true },

    /** friendly = no fee (owner-decided/optional prize); paid = fee → auto prize pool. */
    type: { type: String, enum: ["friendly", "paid"], default: "friendly", index: true },
    currency: { type: String, enum: ["coins"], default: "coins" },
    entryFee: { type: Number, default: 0, min: 0 },
    /** For friendly tournaments an owner may seed a manual prize pool. */
    manualPrizePool: { type: Number, default: 0, min: 0 },
    prizePool: { type: Number, default: 0, min: 0 },
    prizeDistribution: { type: [prizeSlotSchema], default: [] },
    escrowHeld: { type: Number, default: 0, min: 0 },
    prizePaid: { type: Number, default: 0, min: 0 },

    startAt: { type: Date, required: true, index: true },
    maxPlayers: { type: Number, default: 8, min: 2 },
    minPlayers: { type: Number, default: 2, min: 2 },
    format: { type: String, enum: ["single_elim", "round_robin"], default: "single_elim" },
    visibility: { type: String, enum: ["clan"], default: "clan" },

    lifecycle: {
      type: String,
      enum: ["draft", "registering", "seeding", "running", "finished", "cancelled"],
      default: "registering",
      index: true,
    },

    participants: { type: [participantSchema], default: [] },
    rounds: { type: Number, default: 0 },
    currentRound: { type: Number, default: 0 },
    winners: { type: [mongoose.Schema.Types.Mixed], default: [] },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true }
);

clanTournamentSchema.index({ clan: 1, lifecycle: 1, startAt: 1 });
clanTournamentSchema.index({ lifecycle: 1, startAt: 1 });

module.exports = mongoose.model("ClanTournament", clanTournamentSchema);
