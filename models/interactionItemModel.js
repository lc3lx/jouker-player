const mongoose = require("mongoose");

/**
 * Table-interaction catalog — paid emojis, throwable items, premium gifts.
 * One shared catalog for Poker / Tarneeb / Trix. Prices are in Coins (the
 * player's wallet `balance`); the server is the only pricing authority.
 */
const interactionItemSchema = new mongoose.Schema(
  {
    /** Stable string key used by clients + inventory (e.g. "throw_tomato"). */
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    nameAr: { type: String },
    /** Emoji glyph or icon asset path shown in pickers. */
    icon: { type: String, required: true },
    /** Optional shop thumbnail asset. */
    thumbnail: { type: String, default: null },
    /** Animation key the clients play when the item is sent. */
    animation: { type: String, required: true },
    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary", "mythic"],
      default: "common",
      index: true,
    },
    category: {
      type: String,
      enum: ["emoji", "throwable", "gift"],
      required: true,
      index: true,
    },
    /** Pay-per-use price in Coins (charged when the sender owns no stock). */
    price: { type: Number, required: true, min: 0 },
    /** One-time price to own the item permanently (null → not purchasable). */
    unlimitedPrice: { type: Number, default: null, min: 0 },
    /** Per-use Coin cost for permanent owners (0 → free once owned). */
    perUseCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "coins" },
    enabled: { type: Boolean, default: true, index: true },
    seasonal: { type: Boolean, default: false },
    vipOnly: { type: Boolean, default: false },
    limitedEdition: { type: Boolean, default: false },
    /** Bundle contents: [{ key, quantity }] when this item is a bundle. */
    bundle: { type: [{ key: String, quantity: Number }], default: [] },
    /** Anti-spam: minimum ms between sends of THIS item by one player. */
    cooldownMs: { type: Number, default: 3000, min: 0 },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Spec catalog — exact launch pricing. */
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

/** Idempotent seed — inserts missing default items only (admin edits survive). */
interactionItemSchema.statics.ensureDefaults = async function ensureDefaults() {
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const missing = DEFAULT_ITEMS.filter((d) => !have.has(d.key));
  if (missing.length > 0) {
    await this.insertMany(missing, { ordered: false });
  }
  return missing.length;
};

interactionItemSchema.statics.DEFAULT_ITEMS = DEFAULT_ITEMS;

module.exports = mongoose.model("InteractionItem", interactionItemSchema);
