const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true, index: true },
    defaultSalesCommissionPercent: { type: Number, default: 0.05, min: 0, max: 1 },
    defaultReferralCommissionPercent: { type: Number, default: 0.02, min: 0, max: 1 },
    /** In-app currency display name (e.g. رقاقة). */
    currencyName: { type: String, default: "رقاقة", trim: true },
    /** Admin-controlled exchange: how many chips equal 1 USD (internal pricing). */
    chipsPerUsd: { type: Number, default: 10000, min: 1 },
    /**
     * Top-up packages — admin sets chip amounts, USD price (for payment rails), bonuses & promos.
     * priceUsd is NOT shown to players; only chips are displayed in the app.
     */
    chipPackages: {
      type: [
        {
          id: { type: String, required: true },
          chips: { type: Number, required: true, min: 1 },
          priceUsd: { type: Number, default: 0, min: 0 },
          bonusPercent: { type: Number, default: 0, min: 0, max: 100 },
          badge: { type: String, default: null },
          label: { type: String, default: null },
          isActive: { type: Boolean, default: true },
          promoMeta: { type: mongoose.Schema.Types.Mixed, default: null },
        },
      ],
      default: undefined,
    },
  },
  { timestamps: true }
);

systemSettingsSchema.statics.getDefaults = async function () {
  let s = await this.findOne({ key: "default" });
  if (!s) s = await this.create({ key: "default" });
  return s;
};

module.exports = mongoose.model("SystemSettings", systemSettingsSchema);
