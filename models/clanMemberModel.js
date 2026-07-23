const mongoose = require("mongoose");
const { ROLES } = require("../config/clanConfig");

/**
 * Authoritative clan membership. The UNIQUE index on `user` is what enforces
 * "one clan per player" — a second insert for the same user throws a duplicate-key
 * error, which the create/join transaction turns into a clean rejection.
 */
const clanMemberSchema = new mongoose.Schema(
  {
    clan: { type: mongoose.Schema.ObjectId, ref: "Clan", required: true, index: true },
    user: { type: mongoose.Schema.ObjectId, ref: "User", required: true, unique: true },
    role: { type: String, enum: ROLES, default: "member", index: true },
    joinedAt: { type: Date, default: Date.now },

    contribution: {
      donated: { type: Number, default: 0, min: 0 },
      tournamentsPlayed: { type: Number, default: 0, min: 0 },
      tournamentWins: { type: Number, default: 0, min: 0 },
      /**
       * Rolling per-day donation counter. Enforcing the daily cap by aggregating
       * past transactions is a read-then-write race (concurrent donations all see
       * the same stale total); this pair lets the cap be claimed atomically on a
       * single document. `dailyDonatedAt` dates the bucket so it self-resets.
       */
      dailyDonated: { type: Number, default: 0, min: 0 },
      dailyDonatedAt: { type: Date, default: null },
    },

    /** Denormalized snapshot for fast member-list rendering (refreshed lazily). */
    displayName: { type: String, default: null },
    avatar: { type: String, default: null },
  },
  { timestamps: true }
);

clanMemberSchema.index({ clan: 1, role: 1 });
clanMemberSchema.index({ clan: 1, joinedAt: 1 });

module.exports = mongoose.model("ClanMember", clanMemberSchema);
