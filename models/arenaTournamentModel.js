const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true },
    registeredAt: { type: Date, default: Date.now },
    escrow: { type: Number, default: 0, min: 0 },
    tournamentScore: { type: Number, default: 0 },
    chips: { type: Number, default: 0 },
    eliminated: { type: Boolean, default: false },
    finishPlace: { type: Number, default: null },
    tableId: { type: mongoose.Schema.ObjectId, ref: "Table", default: null },
  },
  { _id: false }
);

const prizeSlotSchema = new mongoose.Schema(
  {
    place: { type: Number, required: true, min: 1 },
    percent: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

/**
 * Public / player-created round-based tournaments for poker, trix, tarneeb41.
 * `durationMinutes` stores the target round count (4 / 8 / 12).
 * Money moves only through walletLedgerService inside withMongoTransaction
 * (same pattern as ClanTournament). Independent of the disabled legacy
 * Tournament collection.
 */
const arenaTournamentSchema = new mongoose.Schema(
  {
    origin: { type: String, enum: ["house", "player"], required: true, index: true },
    createdBy: { type: mongoose.Schema.ObjectId, ref: "User" },
    game: { type: String, enum: ["poker", "trix", "tarneeb41"], required: true, index: true },
    tierId: {
      type: String,
      enum: ["mini", "small", "medium", "large", "pro", "custom"],
      default: "custom",
      index: true,
    },

    name: { type: String, required: true, trim: true, maxlength: 80 },

    visibility: { type: String, enum: ["public", "private"], default: "public", index: true },
    inviteCode: { type: String, uppercase: true, trim: true },

    type: { type: String, enum: ["friendly", "paid"], default: "paid", index: true },
    currency: { type: String, enum: ["coins"], default: "coins" },
    entryFee: { type: Number, default: 0, min: 0 },
    createFee: { type: Number, default: 0, min: 0 },
    startingChips: { type: Number, default: 2000, min: 0 },

    prizePool: { type: Number, default: 0, min: 0 },
    guaranteedPrize: { type: Number, default: 0, min: 0 },
    prizeDistribution: { type: [prizeSlotSchema], default: [] },
    escrowHeld: { type: Number, default: 0, min: 0 },
    prizePaid: { type: Number, default: 0, min: 0 },

    startAt: { type: Date, required: true, index: true },
    /** Target round count (4 / 8 / 12). Legacy field name kept for existing docs. */
    durationMinutes: { type: Number, required: true, min: 1, max: 60 },
    endsAt: { type: Date, default: null, index: true },
    maxPlayers: { type: Number, default: 8, min: 2, max: 32 },
    minPlayers: { type: Number, default: 2, min: 2 },

    lifecycle: {
      type: String,
      enum: ["registering", "running", "finished", "cancelled"],
      default: "registering",
      index: true,
    },

    participants: { type: [participantSchema], default: [] },
    tableIds: { type: [mongoose.Schema.ObjectId], default: [] },
    gamesCompleted: { type: Number, default: 0, min: 0 },
    winners: { type: [mongoose.Schema.Types.Mixed], default: [] },

    /** Unique per house slot so the scheduler is idempotent. */
    slotKey: { type: String, default: null },

    /** Admin locked this instance so the house scheduler will not overwrite name/fee. */
    adminEdited: { type: Boolean, default: false },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true }
);

arenaTournamentSchema.index({ lifecycle: 1, startAt: 1 });
arenaTournamentSchema.index({ lifecycle: 1, endsAt: 1 });
arenaTournamentSchema.index({ visibility: 1, lifecycle: 1, game: 1, startAt: 1 });
arenaTournamentSchema.index(
  { slotKey: 1 },
  { unique: true, sparse: true }
);
arenaTournamentSchema.index(
  { inviteCode: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("ArenaTournament", arenaTournamentSchema);
