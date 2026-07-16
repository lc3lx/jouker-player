const mongoose = require("mongoose");

/**
 * Player-owned interaction items. Two ownership modes per the economy spec:
 *  - consumable: `quantity` decrements on every send (no Coin charge);
 *  - unlimited:  permanent ownership; `perUseCost` Coins may apply per send.
 */
const playerInventorySchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    /** InteractionItem.key */
    itemKey: { type: String, required: true, index: true },
    quantity: { type: Number, default: 0, min: 0 },
    unlimited: { type: Boolean, default: false },
    /** daily_reward | vip | battle_pass | event | achievement | referral | admin_gift | purchase */
    source: { type: String, default: "purchase" },
  },
  { timestamps: true }
);

playerInventorySchema.index({ user: 1, itemKey: 1 }, { unique: true });

module.exports = mongoose.model("PlayerInventory", playerInventorySchema);
