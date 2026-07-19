const mongoose = require("mongoose");

/**
 * Per-user cosmetic ownership + equip state.
 *
 * `equippedBySlot` is the data-driven source of truth: an unlimited map of
 * slotKey → Cosmetic id, so new cosmetic kinds (chip sets, dealer themes,
 * entrance effects, chat badges, name colors, future games) need no schema
 * change. The legacy `equipped.{tableTheme,cardSkin,avatarFrame}` fields are kept
 * as a write-through MIRROR so every existing read path keeps working.
 */
const userCosmeticsSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    ownedItems: [{ type: mongoose.Schema.ObjectId, ref: "Cosmetic" }],
    /** slotKey (CosmeticSlot.key) → Cosmetic id. Unlimited slots. */
    equippedBySlot: {
      type: Map,
      of: { type: mongoose.Schema.ObjectId, ref: "Cosmetic" },
      default: () => new Map(),
    },
    /** Legacy mirror — kept in sync from equippedBySlot for backward compat. */
    equipped: {
      tableTheme: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", default: null },
      cardSkin: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", default: null },
      avatarFrame: { type: mongoose.Schema.ObjectId, ref: "Cosmetic", default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("UserCosmetics", userCosmeticsSchema);
