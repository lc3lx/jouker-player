const mongoose = require("mongoose");

/**
 * Economy currencies. The platform is Coins-ONLY today (virtual, wallet
 * `balance`), but the catalog references currencies by stable `code` so future
 * currencies can be added from the Admin CMS without a code change. There is NO
 * fiat / payment-gateway currency here by design.
 */
const currencySchema = new mongoose.Schema(
  {
    /** Stable string id used by catalog items (e.g. "coins"). */
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    symbol: { type: String, default: null },
    icon: { type: String, default: null },
    /** Only the default currency's balance lives in the wallet today. */
    isDefault: { type: Boolean, default: false },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const DEFAULT_CURRENCIES = [
  { code: "coins", name: "Coins", nameAr: "رقائق", symbol: "🪙", isDefault: true, enabled: true, sortOrder: 0 },
];

/** Idempotent seed — the default Coins currency always exists. */
currencySchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("code").lean();
  const have = new Set(existing.map((d) => d.code));
  const missing = DEFAULT_CURRENCIES.filter((d) => !have.has(d.code));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });
  return missing.length;
};

currencySchema.statics.DEFAULT_CURRENCIES = DEFAULT_CURRENCIES;
currencySchema.statics.DEFAULT_CODE = "coins";

module.exports = mongoose.model("Currency", currencySchema);
