const mongoose = require("mongoose");

/**
 * Equip-slot registry. A player can equip ONE cosmetic per slot. Slots are
 * data-driven so future cosmetic kinds (chip sets, dealer themes, entrance
 * effects, chat badges, name colors, future games) need no schema/code change —
 * an admin just registers a new slot and tags cosmetics with it.
 *
 * `legacyField` maps a slot onto the pre-existing UserCosmetics.equipped.{...}
 * field so old reads keep working (write-through mirror in cosmeticsService).
 */
const cosmeticSlotSchema = new mongoose.Schema(
  {
    /** Stable slot key stored on cosmetics + in equippedBySlot (e.g. "avatar_frame"). */
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    /** Which games this slot applies to (["all"] or specific game keys). */
    games: { type: [String], default: ["all"] },
    /** Legacy equipped.{field} mirror target, or null for new slots. */
    legacyField: { type: String, default: null, enum: [null, "tableTheme", "cardSkin", "avatarFrame"] },
    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const DEFAULT_SLOTS = [
  { key: "avatar_frame", name: "Profile Frame", nameAr: "إطار الحساب", games: ["all"], legacyField: "avatarFrame", sortOrder: 1 },
  { key: "table_theme", name: "Table Theme", nameAr: "ثيم الطاولة", games: ["poker"], legacyField: "tableTheme", sortOrder: 2 },
  { key: "card_back", name: "Card Back", nameAr: "ظهر الأوراق", games: ["poker"], legacyField: "cardSkin", sortOrder: 3 },
  { key: "chip_set", name: "Chip Set", nameAr: "طقم الرقائق", games: ["poker"], legacyField: null, sortOrder: 4 },
  { key: "dealer_theme", name: "Dealer Theme", nameAr: "ثيم الموزّع", games: ["poker"], legacyField: null, sortOrder: 5 },
  { key: "entrance_effect", name: "Entrance Effect", nameAr: "تأثير الدخول", games: ["all"], legacyField: null, sortOrder: 6 },
  { key: "win_effect", name: "Win Effect", nameAr: "تأثير الفوز", games: ["all"], legacyField: null, sortOrder: 7 },
  { key: "chat_badge", name: "Chat Badge", nameAr: "شارة الدردشة", games: ["all"], legacyField: null, sortOrder: 8 },
  { key: "name_color", name: "Name Color", nameAr: "لون الاسم", games: ["all"], legacyField: null, sortOrder: 9 },
  { key: "animated_border", name: "Animated Border", nameAr: "إطار متحرك", games: ["all"], legacyField: null, sortOrder: 10 },
];

/** Legacy cosmetic `type` → slot key (for backfill + create defaults). */
const TYPE_TO_SLOT = {
  table_theme: "table_theme",
  card_skin: "card_back",
  avatar_frame: "avatar_frame",
  bundle: null,
};

cosmeticSlotSchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_SLOTS.filter((d) => !have.has(d.key));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });
  return missing.length;
};

cosmeticSlotSchema.statics.DEFAULT_SLOTS = DEFAULT_SLOTS;
cosmeticSlotSchema.statics.TYPE_TO_SLOT = TYPE_TO_SLOT;

module.exports = mongoose.model("CosmeticSlot", cosmeticSlotSchema);
