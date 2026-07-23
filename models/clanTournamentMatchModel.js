const mongoose = require("mongoose");

/**
 * One match (bracket node) of a ClanTournament. When a match goes live the engine
 * spawns a private game table and stores its id in `tableId`; the unified
 * game-finish hook resolves the match by looking it up via that table. `advanced`
 * is the idempotency guard so a finished match promotes its winner exactly once.
 */
const clanTournamentMatchSchema = new mongoose.Schema(
  {
    tournament: { type: mongoose.Schema.ObjectId, ref: "ClanTournament", required: true, index: true },
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    round: { type: Number, required: true, min: 1 },
    matchIndex: { type: Number, required: true, min: 0 },

    players: [{ type: mongoose.Schema.ObjectId, ref: "User" }],
    /** Slot in the NEXT round this match's winner advances into. */
    nextMatchIndex: { type: Number, default: null },

    tableId: { type: mongoose.Schema.ObjectId, ref: "Table", default: null, index: true },
    status: {
      type: String,
      enum: ["pending", "live", "finished", "walkover"],
      default: "pending",
      index: true,
    },
    winner: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },

    /** Idempotency: set true once the winner has been promoted to the next round. */
    advanced: { type: Boolean, default: false },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    /** Auto-resolve deadline for no-shows / abandoned matches. */
    deadlineAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clanTournamentMatchSchema.index({ tournament: 1, round: 1, matchIndex: 1 }, { unique: true });
clanTournamentMatchSchema.index({ status: 1, deadlineAt: 1 });

module.exports = mongoose.model("ClanTournamentMatch", clanTournamentMatchSchema);
