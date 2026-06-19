const mongoose = require("mongoose");

const cosmeticSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["table_theme", "card_skin", "avatar_frame", "bundle"],
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    /** Client asset pack id (folder name under assets). */
    assetKey: { type: String, required: true, trim: true, index: true },
    /** Admin-uploaded store preview (filename under uploads/cosmetics). */
    previewImage: { type: String, trim: true, default: null },
    price: { type: Number, required: true, min: 0, default: 0 },
    rarity: {
      type: String,
      enum: ["common", "rare", "epic"],
      default: "common",
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    /** Store hero / carousel; order within featured strip. */
    featured: { type: Boolean, default: false, index: true },
    featuredOrder: { type: Number, default: 0 },
    /** Rough engagement signals (incremented on buy / equip). */
    purchaseCount: { type: Number, default: 0, min: 0 },
    equipCount: { type: Number, default: 0, min: 0 },
    /**
     * Monetization hooks:
     * - discountPercent (0–100), expiresAt (ISO date)
     * - items OR bundleGrants: [ObjectId] — grant list when type === bundle
     * - bundlePrice optional mirror of price (client convenience)
     */
    promoMeta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

cosmeticSchema.index({ type: 1, isActive: 1, assetKey: 1 });
cosmeticSchema.index({ isActive: 1, featured: 1, featuredOrder: 1 });

module.exports = mongoose.model("Cosmetic", cosmeticSchema);
