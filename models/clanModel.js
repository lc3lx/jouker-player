const mongoose = require("mongoose");
const { JOIN_TYPES, CLAN_DEFAULTS } = require("../config/clanConfig");

/**
 * A Clan (Guild). Membership is NOT embedded here — it lives in the ClanMember
 * collection (unique index on `user` enforces one-clan-per-player). `memberCount`
 * is a denormalized cache kept in sync on join/leave inside the same transaction.
 */
const clanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40, index: true },
    /** 2–6 chars, shown as [TAG] everywhere. Unique + uppercase. */
    tag: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: CLAN_DEFAULTS.tagMinLen,
      maxlength: CLAN_DEFAULTS.tagMaxLen,
      unique: true,
      index: true,
    },
    description: { type: String, default: "", maxlength: 500, trim: true },
    country: { type: String, uppercase: true, trim: true, index: true },
    language: { type: String, lowercase: true, trim: true, default: "ar", index: true },
    logo: { type: String, default: null },
    banner: { type: String, default: null },

    joinType: { type: String, enum: JOIN_TYPES, default: "public", index: true },

    owner: { type: mongoose.Schema.ObjectId, ref: "User", required: true, index: true },
    memberCount: { type: Number, default: 1, min: 0 },
    maxMembers: { type: Number, default: CLAN_DEFAULTS.maxMembersDefault, min: 1 },

    status: {
      type: String,
      enum: ["active", "banned", "deleted"],
      default: "active",
      index: true,
    },
    bannedReason: { type: String, default: null },
    bannedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },

    treasury: {
      balance: { type: Number, default: 0, min: 0 },
    },

    stats: {
      rankScore: { type: Number, default: 0, index: true },
      tournamentWins: { type: Number, default: 0 },
      pokerWins: { type: Number, default: 0 },
      trixWins: { type: Number, default: 0 },
      tarneebWins: { type: Number, default: 0 },
      gamesPlayed: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      losses: { type: Number, default: 0 },
      coinsWon: { type: Number, default: 0 },
      coinsLost: { type: Number, default: 0 },
      weeklyActivity: { type: Number, default: 0 },
      monthlyActivity: { type: Number, default: 0 },
    },

    /** Progression scaffolding — reserved, unused until Clan Levels ship. */
    level: { type: Number, default: 1, min: 1 },
    xp: { type: Number, default: 0, min: 0 },

    /**
     * Per-clan permission override, shape { role: [permissionKey, ...] }. Empty
     * object → fall back to config DEFAULT_ROLE_PERMISSIONS. See clanPermissionService.
     */
    rolePermissions: { type: mongoose.Schema.Types.Mixed, default: {} },

    // ── Future expansion (reserved Mixed slots; never populated initially) ──
    season: { type: mongoose.Schema.Types.Mixed, default: null },
    war: { type: mongoose.Schema.Types.Mixed, default: null },
    quests: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

clanSchema.index({ status: 1, "stats.rankScore": -1 });
clanSchema.index({ country: 1, "stats.rankScore": -1 });
// NOTE: intentionally NO $text index — the `language` field would be treated as a
// per-document text-search language override (and "ar" is unsupported). Name/tag
// search uses $regex in clanService.browseClans instead.

module.exports = mongoose.model("Clan", clanSchema);
