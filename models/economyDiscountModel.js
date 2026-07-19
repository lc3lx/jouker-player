const mongoose = require("mongoose");

/**
 * Catalog discounts & flash sales. A flash sale is simply a discount with a
 * tight [startDate, endDate] window and `flashSale:true`. Discounts reduce the
 * Coin price shown/charged in the shop; they never introduce fiat currency.
 *
 * Scope resolution (most specific wins is NOT assumed — the best/highest active
 * discount for an item is applied; see economyDiscountService.resolveEffectivePrice).
 */
const economyDiscountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    /** "percentage" → value is 0..100; "fixed" → value is Coins removed. */
    type: { type: String, enum: ["percentage", "fixed"], required: true },
    value: { type: Number, required: true, min: 0 },
    /** What the discount applies to. */
    appliesTo: {
      type: String,
      enum: ["all", "items", "categories", "rarities"],
      default: "items",
    },
    /** Item keys / category keys / rarity names, depending on appliesTo. */
    targets: { type: [String], default: [] },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    active: { type: Boolean, default: true, index: true },
    flashSale: { type: Boolean, default: false },
    vipOnly: { type: Boolean, default: false },
    /** Restrict to a season being live (references EconomySeason.key). */
    eventSeasonKey: { type: String, default: null },
    /** Optional floor so a stacked/large discount can't drive price below this. */
    minPrice: { type: Number, default: 0, min: 0 },
    priority: { type: Number, default: 0 },
  },
  { timestamps: true }
);

economyDiscountSchema.index({ active: 1, startDate: 1, endDate: 1 });

/** Time/enabled gate only — target matching is done by the service. */
economyDiscountSchema.methods.isLive = function isLive(at = Date.now()) {
  if (!this.active) return false;
  const t = at instanceof Date ? at.getTime() : at;
  if (this.startDate && t < this.startDate.getTime()) return false;
  if (this.endDate && t > this.endDate.getTime()) return false;
  return true;
};

module.exports = mongoose.model("EconomyDiscount", economyDiscountSchema);
