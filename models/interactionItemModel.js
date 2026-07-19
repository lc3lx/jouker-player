const mongoose = require("mongoose");

/**
 * Table-interaction catalog — paid emojis, throwable items, premium gifts, and
 * any future item type. Fully data-driven: `category`/`rarity` are FREE STRINGS
 * (managed sets live in InteractionCategory and code constants) so admins can
 * add new categories/rarities from the CMS without a schema/code change.
 *
 * One shared catalog for Poker / Tarneeb / Trix. Prices are in Coins (the
 * player's wallet `balance`); the server is the only pricing authority. There is
 * NO fiat / payment-gateway currency — items reference a virtual currency by
 * stable `currencyId` code (default "coins").
 *
 * Lifecycle (soft-delete): draft → published → disabled → archived. Only a
 * Super Admin may permanently delete. `enabled` is kept in sync with `status`
 * (true only when published) purely for backward compatibility with older reads.
 */

const STATUSES = ["draft", "published", "disabled", "archived"];
const RARITIES = ["common", "rare", "epic", "legendary", "mythic"];
const INVENTORY_TYPES = ["consumable", "unlimited", "both"];

const bundleEntrySchema = new mongoose.Schema(
  { key: { type: String, required: true }, quantity: { type: Number, default: 1, min: 1 } },
  { _id: false }
);

const interactionItemSchema = new mongoose.Schema(
  {
    /** Stable string key used by clients + inventory (e.g. "throw_tomato"). NEVER changes. */
    key: { type: String, required: true, unique: true },

    // ── identity / localization ──────────────────────────────────────────────
    name: { type: String, required: true },
    displayName: { type: String, default: null },
    /** Localized names. `nameAr` kept for backward compat; mirror of arabicName. */
    nameAr: { type: String, default: null },
    arabicName: { type: String, default: null },
    englishName: { type: String, default: null },
    description: { type: String, default: null },

    // ── taxonomy (free strings — data driven) ────────────────────────────────
    category: { type: String, required: true, index: true },
    subCategory: { type: String, default: null, index: true },
    /** Free string; RARITIES lists the known defaults but admins may add more. */
    rarity: { type: String, default: "common", index: true },
    tags: { type: [String], default: [] },

    // ── media / effects ──────────────────────────────────────────────────────
    icon: { type: String, required: true },
    thumbnail: { type: String, default: null },
    animation: { type: String, required: true },
    animationPath: { type: String, default: null },
    animationDuration: { type: Number, default: null },
    animationScale: { type: Number, default: null },
    animationSpeed: { type: Number, default: null },
    sound: { type: String, default: null },
    impactEffect: { type: String, default: null },
    particleEffect: { type: String, default: null },
    glowEffect: { type: String, default: null },

    // ── pricing (Coins only) ─────────────────────────────────────────────────
    /** Pay-per-use price in Coins (charged when the sender owns no stock). */
    price: { type: Number, required: true, min: 0 },
    /** One-time price to own the item permanently (null → not purchasable). */
    unlimitedPrice: { type: Number, default: null, min: 0 },
    /** Per-use Coin cost for permanent owners (0 → free once owned). */
    perUseCost: { type: Number, default: 0, min: 0 },
    /** Legacy display string; kept in sync with currencyId. */
    currency: { type: String, default: "coins" },
    /** Stable currency code (Currency.code). Default virtual "coins". */
    currencyId: { type: String, default: "coins", index: true },

    // ── inventory model ──────────────────────────────────────────────────────
    inventoryType: { type: String, enum: INVENTORY_TYPES, default: "both" },
    consumable: { type: Boolean, default: true },
    unlimited: { type: Boolean, default: true },

    // ── lifecycle / visibility ───────────────────────────────────────────────
    status: { type: String, enum: STATUSES, default: "draft", index: true },
    /** Backward-compat mirror: enabled === (status === "published"). */
    enabled: { type: Boolean, default: false, index: true },
    hidden: { type: Boolean, default: false },
    featured: { type: Boolean, default: false, index: true },
    recommended: { type: Boolean, default: false, index: true },
    popular: { type: Boolean, default: false, index: true },
    seasonal: { type: Boolean, default: false },
    limitedEdition: { type: Boolean, default: false },

    // ── access requirements ──────────────────────────────────────────────────
    vipOnly: { type: Boolean, default: false },
    vipLevel: { type: Number, default: 0 },
    requiredLevel: { type: Number, default: 0 },
    requiredAchievement: { type: String, default: null },
    /** EconomySeason.key this item belongs to (also gates availability). */
    requiredSeason: { type: String, default: null, index: true },
    requiredPackage: { type: String, default: null },

    // ── limits / anti-spam ───────────────────────────────────────────────────
    /** Minimum ms between sends of THIS item by one player. */
    cooldownMs: { type: Number, default: 3000, min: 0 },
    cooldown: { type: Number, default: null }, // alias (ms); mirrors cooldownMs when set
    dailyLimit: { type: Number, default: 0 }, // 0 → unlimited
    matchLimit: { type: Number, default: 0 },
    queueLimit: { type: Number, default: 0 },

    // ── bundles ──────────────────────────────────────────────────────────────
    /** Bundle contents: [{ key, quantity }] when this item is a bundle. */
    bundle: { type: [bundleEntrySchema], default: [] },

    sortOrder: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

interactionItemSchema.index({ status: 1, sortOrder: 1 });

/** Keep the legacy `enabled` / `currency` / localization mirrors consistent. */
interactionItemSchema.pre("save", function syncMirrors(next) {
  this.enabled = this.status === "published";
  if (this.currencyId) this.currency = this.currencyId;
  if (this.arabicName && !this.nameAr) this.nameAr = this.arabicName;
  if (this.nameAr && !this.arabicName) this.arabicName = this.nameAr;
  if (typeof this.cooldown === "number" && this.cooldown >= 0) this.cooldownMs = this.cooldown;
  next();
});

/** Spec catalog — exact launch pricing. Seeded as PUBLISHED for backward compat. */
const DEFAULT_ITEMS = [
  // Basic emojis
  { key: "emoji_smile", name: "Smile", icon: "😀", animation: "emoji_pop", category: "emoji", price: 50, cooldownMs: 1500, sortOrder: 1 },
  { key: "emoji_laugh", name: "Laugh", icon: "😂", animation: "emoji_pop", category: "emoji", price: 75, cooldownMs: 1500, sortOrder: 2 },
  { key: "emoji_heart", name: "Heart", icon: "❤️", animation: "emoji_float", category: "emoji", price: 100, cooldownMs: 1500, sortOrder: 3 },
  { key: "emoji_clap", name: "Clap", icon: "👏", animation: "emoji_pop", category: "emoji", price: 120, cooldownMs: 1500, sortOrder: 4 },
  { key: "emoji_fire", name: "Fire", icon: "🔥", animation: "emoji_burst", category: "emoji", price: 150, cooldownMs: 1500, sortOrder: 5 },
  // Throwables
  { key: "throw_tomato", name: "Tomato", icon: "🍅", animation: "throw_splat", category: "throwable", rarity: "common", price: 250, sortOrder: 10 },
  { key: "throw_egg", name: "Egg", icon: "🥚", animation: "throw_crack", category: "throwable", rarity: "common", price: 300, sortOrder: 11 },
  { key: "throw_plane", name: "Paper Plane", icon: "✈️", animation: "throw_glide", category: "throwable", rarity: "common", price: 400, sortOrder: 12 },
  { key: "throw_flower", name: "Flower", icon: "🌸", animation: "throw_bloom", category: "throwable", rarity: "rare", price: 500, sortOrder: 13 },
  { key: "throw_rose", name: "Rose", icon: "🌹", animation: "throw_bloom", category: "throwable", rarity: "rare", price: 750, sortOrder: 14 },
  { key: "throw_cake", name: "Cake", icon: "🎂", animation: "throw_splat", category: "throwable", rarity: "rare", price: 1000, sortOrder: 15 },
  { key: "throw_bomb", name: "Bomb", icon: "💣", animation: "throw_explode", category: "throwable", rarity: "epic", price: 1500, sortOrder: 16 },
  { key: "throw_moneybag", name: "Money Bag", icon: "💰", animation: "throw_coins", category: "throwable", rarity: "epic", price: 2500, sortOrder: 17 },
  { key: "throw_moneyrain", name: "Money Rain", icon: "🤑", animation: "money_rain", category: "throwable", rarity: "legendary", price: 5000, cooldownMs: 8000, sortOrder: 18 },
  // Premium gifts
  { key: "gift_ring", name: "Diamond Ring", icon: "💍", animation: "gift_shine", category: "gift", rarity: "epic", price: 25000, cooldownMs: 10000, sortOrder: 30 },
  { key: "gift_car", name: "Sports Car", icon: "🏎️", animation: "gift_drive", category: "gift", rarity: "epic", price: 75000, cooldownMs: 10000, sortOrder: 31 },
  { key: "gift_helicopter", name: "Helicopter", icon: "🚁", animation: "gift_fly", category: "gift", rarity: "legendary", price: 150000, cooldownMs: 15000, sortOrder: 32 },
  { key: "gift_jet", name: "Private Jet", icon: "🛩️", animation: "gift_fly", category: "gift", rarity: "legendary", price: 300000, cooldownMs: 15000, sortOrder: 33 },
  { key: "gift_trophy", name: "Golden Trophy", icon: "🏆", animation: "gift_shine", category: "gift", rarity: "legendary", price: 500000, cooldownMs: 15000, sortOrder: 34 },
  { key: "gift_castle", name: "Castle", icon: "🏰", animation: "gift_epic", category: "gift", rarity: "mythic", price: 1000000, cooldownMs: 20000, sortOrder: 35 },
  { key: "gift_dragon", name: "Dragon", icon: "🐉", animation: "gift_epic", category: "gift", rarity: "mythic", price: 2500000, cooldownMs: 20000, sortOrder: 36 },
];

let _backfilled = false;

/**
 * Idempotent seed + one-time legacy backfill.
 *  - inserts missing default items (as PUBLISHED so the shop shows them);
 *  - backfills pre-CMS docs that predate the `status`/`currencyId` fields so
 *    the status-driven catalog keeps returning them.
 * Admin edits always survive (we never overwrite an existing key).
 */
interactionItemSchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_ITEMS
    .filter((d) => !have.has(d.key))
    .map((d) => ({ ...d, status: "published", enabled: true, currencyId: "coins", currency: "coins" }));
  if (missing.length > 0) await this.insertMany(missing, { ordered: false });

  if (!_backfilled) {
    // Legacy docs created before the CMS lack `status`; derive it from `enabled`.
    const legacy = await this.countDocuments({ status: { $exists: false } });
    if (legacy > 0) {
      await this.updateMany({ status: { $exists: false }, enabled: true }, { $set: { status: "published" } });
      await this.updateMany({ status: { $exists: false }, enabled: { $ne: true } }, { $set: { status: "disabled" } });
    }
    await this.updateMany(
      { $or: [{ currencyId: { $exists: false } }, { currencyId: null }] },
      { $set: { currencyId: "coins" } }
    );
    _backfilled = true;
  }
  return missing.length;
};

/** Test/ops helper: allow the backfill to run again. */
interactionItemSchema.statics.resetBackfillFlag = function resetBackfillFlag() {
  _backfilled = false;
};

interactionItemSchema.statics.DEFAULT_ITEMS = DEFAULT_ITEMS;
interactionItemSchema.statics.STATUSES = STATUSES;
interactionItemSchema.statics.RARITIES = RARITIES;
interactionItemSchema.statics.INVENTORY_TYPES = INVENTORY_TYPES;

module.exports = mongoose.model("InteractionItem", interactionItemSchema);
