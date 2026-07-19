const mongoose = require("mongoose");

/**
 * VIP → cosmetic reward links. Replaces the hardcoded config/vipCosmeticsConfig.js
 * mapping. Admin can grant ANY cosmetic to ANY VIP level (table themes, card backs,
 * profile frames, chip sets, dealer themes, animated effects, future cosmetics),
 * per game. No hardcoded reward lists.
 */
const vipRewardSchema = new mongoose.Schema(
  {
    /** VipLevel.key this reward belongs to. */
    vipLevelKey: { type: String, required: true, index: true },
    /** Granted cosmetic. */
    cosmeticId: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", required: true, index: true },
    /** Optional game scope override (else the cosmetic's own `games`). */
    gameKey: { type: String, default: null },
    /** Auto-equip the reward while the VIP level is active (table felt / card backs). */
    autoEquip: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

vipRewardSchema.index({ vipLevelKey: 1, cosmeticId: 1 }, { unique: true });

module.exports = mongoose.model("VipReward", vipRewardSchema);
