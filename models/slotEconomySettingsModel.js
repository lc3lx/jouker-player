const mongoose = require("mongoose");

/**
 * Admin-selected economy settings for one slot game (one document per game).
 *
 * Odds are never edited here: `activeProfileId` points at an immutable,
 * offline-calibrated profile (games/slotProfiles). A profile switch is written
 * as `pending` with an `effectiveAt` a few seconds ahead so every server
 * instance flips at the same moment.
 */
const slotEconomySettingsSchema = new mongoose.Schema(
  {
    game: { type: String, enum: ["poseidon", "zeus", "zenobia"], required: true, unique: true },

    /** false = the game still runs its legacy economy (pre-profile engines). */
    // No schema default: an unset flag means "the game's default" (see
    // services/slotEconomySettingsService.js defaultLiveGames).
    economyLive: { type: Boolean },
    activeProfileId: { type: String, default: null },
    pending: {
      profileId: { type: String, default: null },
      effectiveAt: { type: Date, default: null },
    },
    /** When the active profile last changed (for the change cooldown). */
    profileChangedAt: { type: Date, default: null },

    /** Paid spins and buys allowed. Already-paid bonus rounds always finish. */
    enabled: { type: Boolean, default: true },
    buyEnabled: { type: Boolean, default: true },
    superBuyEnabled: { type: Boolean, default: true },
    minBet: { type: Number, default: 10000, min: 1 },
    maxBet: { type: Number, default: 1000000000, min: 1 },

    revision: { type: Number, default: 0 },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, collection: "slot_economy_settings" },
);

module.exports = mongoose.model("SlotEconomySettings", slotEconomySettingsSchema);
