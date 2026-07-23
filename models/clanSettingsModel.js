const mongoose = require("mongoose");
const { CLAN_DEFAULTS, DEFAULT_ROLE_PERMISSIONS } = require("../config/clanConfig");

/**
 * Singleton admin-tunable configuration for the whole Clan system. Mirrors the
 * SystemSettings pattern (key="default", getDefaults()). Every magic value the
 * clan system needs (creation cost, limits, default permission matrix) is read
 * from here so admins can change them without a deploy.
 */
const clanSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, default: "default", index: true },

    creationCost: { type: Number, default: CLAN_DEFAULTS.creationCost, min: 0 },
    maxMembersDefault: { type: Number, default: CLAN_DEFAULTS.maxMembersDefault, min: 1 },
    tagMinLen: { type: Number, default: CLAN_DEFAULTS.tagMinLen, min: 1 },
    tagMaxLen: { type: Number, default: CLAN_DEFAULTS.tagMaxLen, min: 1 },
    maxTournamentsPerClan: { type: Number, default: CLAN_DEFAULTS.maxTournamentsPerClan, min: 0 },
    treasuryEnabled: { type: Boolean, default: CLAN_DEFAULTS.treasuryEnabled },
    donationDailyLimit: { type: Number, default: CLAN_DEFAULTS.donationDailyLimit, min: 0 },
    minDonation: { type: Number, default: CLAN_DEFAULTS.minDonation, min: 0 },

    /**
     * Global default permission matrix { role: [permissionKey, ...] }. A clan may
     * override per-clan via Clan.rolePermissions. Falls back to config on empty.
     */
    defaultRolePermissions: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ ...DEFAULT_ROLE_PERMISSIONS }),
    },
  },
  { timestamps: true }
);

clanSettingsSchema.statics.getDefaults = async function getDefaults() {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("ClanSettings", clanSettingsSchema);
