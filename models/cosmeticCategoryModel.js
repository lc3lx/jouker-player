const mongoose = require("mongoose");

/**
 * Store categories for cosmetics — a managed, UNLIMITED set. The `Cosmetic.category`
 * field is a free string, so adding a category here never requires a schema/code
 * change. Categories drive the store's dynamic sections (Profile Frames, Poker
 * Tables, Card Backs, Dealer Themes, Chip Sets, …).
 */
const cosmeticCategorySchema = new mongoose.Schema(
  {
    /** Stable key stored on cosmetics (e.g. "avatar_frame"). */
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    icon: { type: String, default: null },
    description: { type: String, default: null },
    /** Which games this category is relevant to (["all"] or specific game keys). */
    games: { type: [String], default: ["all"] },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Seed defaults mirror the legacy cosmetic `type` values so nothing breaks. */
const DEFAULT_CATEGORIES = [
  { key: "avatar_frame", name: "Profile Frames", nameAr: "إطارات الحساب", icon: "🖼️", games: ["all"], sortOrder: 1 },
  { key: "table_theme", name: "Poker Tables", nameAr: "طاولات", icon: "🎰", games: ["poker"], sortOrder: 2 },
  { key: "card_skin", name: "Card Backs", nameAr: "ظهر الأوراق", icon: "🂠", games: ["poker"], sortOrder: 3 },
  { key: "bundle", name: "Bundles", nameAr: "باقات", icon: "🎁", games: ["all"], sortOrder: 4 },
];

cosmeticCategorySchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_CATEGORIES.filter((d) => !have.has(d.key));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });
  return missing.length;
};

cosmeticCategorySchema.statics.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;

module.exports = mongoose.model("CosmeticCategory", cosmeticCategorySchema);
