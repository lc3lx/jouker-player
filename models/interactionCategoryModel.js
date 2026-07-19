const mongoose = require("mongoose");

/**
 * Managed set of interaction categories (emoji / throwable / gift / …). The
 * catalog `category` field is a FREE STRING so items never break when a new
 * category is added; this collection is the admin-managed source of truth for
 * the category list, ordering and display metadata. Unlimited categories.
 */
const interactionCategorySchema = new mongoose.Schema(
  {
    /** Stable string key stored on items (e.g. "throwable"). */
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    icon: { type: String, default: null },
    description: { type: String, default: null },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const DEFAULT_CATEGORIES = [
  { key: "emoji", name: "Emojis", nameAr: "إيموجي", icon: "😀", sortOrder: 1 },
  { key: "throwable", name: "Throwables", nameAr: "رميات", icon: "🍅", sortOrder: 2 },
  { key: "gift", name: "Gifts", nameAr: "هدايا", icon: "🎁", sortOrder: 3 },
];

interactionCategorySchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_CATEGORIES.filter((d) => !have.has(d.key));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });
  return missing.length;
};

interactionCategorySchema.statics.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;

module.exports = mongoose.model("InteractionCategory", interactionCategorySchema);
