const mongoose = require("mongoose");

/**
 * Cosmetic catalog — profile frames, table themes, card backs, chip sets, dealer
 * themes, entrance/win effects, chat badges, name colors, bundles, and any FUTURE
 * kind. Fully data-driven: `type`, `category`, `rarity` and `slot` are free
 * strings (managed sets live in CosmeticCategory / CosmeticSlot) so new kinds
 * need no schema/code change. One document can belong to store + VIP + season +
 * multiple games (no asset duplication).
 *
 * Backward compatibility: `isActive` stays the authoritative visibility flag that
 * the public catalog filters on; `status` is the richer CMS lifecycle mirror.
 * `type` values (`table_theme|card_skin|avatar_frame|bundle`) are preserved.
 */

/** Legacy type → equip slot (kept in sync with cosmeticSlotModel.TYPE_TO_SLOT). */
const TYPE_TO_SLOT = { table_theme: "table_theme", card_skin: "card_back", avatar_frame: "avatar_frame", bundle: null };
const RENDER_TYPES = ["png", "webp", "gif", "lottie", "rive"];
const STATUSES = ["draft", "published", "disabled", "archived"];

function defaultGamesForType(type) {
  if (type === "table_theme" || type === "card_skin") return ["poker"];
  return ["all"];
}

const cosmeticSchema = new mongoose.Schema(
  {
    // ── taxonomy (free strings — data driven) ────────────────────────────────
    /** Kept for backward compat; new kinds may use any string. */
    type: { type: String, required: true, index: true },
    /** Store category key (CosmeticCategory.key). Defaults to `type`. */
    category: { type: String, default: null, index: true },
    /** Equip slot key (CosmeticSlot.key). One equipped cosmetic per slot. */
    slot: { type: String, default: null, index: true },
    /** Games this cosmetic applies to (["all"] or specific game keys). */
    games: { type: [String], default: [], index: true },

    name: { type: String, required: true, trim: true },
    nameAr: { type: String, default: null },
    description: { type: String, default: null },

    /** Client asset pack id (folder name under assets). */
    assetKey: { type: String, required: true, trim: true, index: true },
    /** Admin-uploaded store preview (filename under uploads/cosmetics). */
    previewImage: { type: String, trim: true, default: null },

    // ── render (static + animated) ───────────────────────────────────────────
    renderType: { type: String, enum: RENDER_TYPES, default: "png" },
    /** Animated variant asset key/filename (gif/lottie/rive). */
    animatedAssetKey: { type: String, default: null },
    /** Absolute or resolvable URL for the animated asset (admin-provided). */
    animationUrl: { type: String, default: null },

    // ── pricing (Coins) ──────────────────────────────────────────────────────
    price: { type: Number, required: true, min: 0, default: 0 },
    /** Stable currency code (Currency.code). Cosmetics are Coins today. */
    currencyId: { type: String, default: "coins" },
    rarity: { type: String, default: "common", index: true },

    // ── availability / access ────────────────────────────────────────────────
    /** Authoritative visibility flag (public catalog filters on this). */
    isActive: { type: Boolean, default: true, index: true },
    /** Richer CMS lifecycle, mirrored to isActive. */
    status: { type: String, enum: STATUSES, default: null, index: true },
    /** Store hero / carousel; order within featured strip. */
    featured: { type: Boolean, default: false, index: true },
    featuredOrder: { type: Number, default: 0 },
    sortOrder: { type: Number, default: 0 },
    /** VIP level key required to obtain/equip (null = open). */
    vipLevelRequired: { type: String, default: null, index: true },
    /** Season key (EconomySeason.key) this cosmetic belongs to. */
    season: { type: String, default: null, index: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    limitedEdition: { type: Boolean, default: false },

    /** Rough engagement signals (incremented on buy / equip). */
    purchaseCount: { type: Number, default: 0, min: 0 },
    equipCount: { type: Number, default: 0, min: 0 },
    /**
     * Monetization hooks:
     * - discountPercent (0–100), expiresAt (ISO date)
     * - items OR bundleGrants: [ObjectId] — grant list when type === bundle
     */
    promoMeta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

cosmeticSchema.index({ type: 1, isActive: 1, assetKey: 1 });
cosmeticSchema.index({ isActive: 1, featured: 1, featuredOrder: 1 });
cosmeticSchema.index({ category: 1, isActive: 1 });
cosmeticSchema.index({ slot: 1, isActive: 1 });

/**
 * Fill data-driven defaults + keep the status↔isActive mirror consistent.
 * Runs on `validate` (before enum validation) so the `status` default is resolved
 * to a valid value rather than the null placeholder.
 */
cosmeticSchema.pre("validate", function syncCosmeticDefaults(next) {
  if (!this.renderType) this.renderType = "png";
  if (!this.currencyId) this.currencyId = "coins";
  if (this.slot == null) this.slot = TYPE_TO_SLOT[this.type] ?? this.type ?? null;
  if (!this.category) this.category = this.type || "misc";
  if (!this.games || this.games.length === 0) this.games = defaultGamesForType(this.type);

  if (this.isModified("status") && this.status) {
    this.isActive = this.status === "published";
  } else if (!this.status) {
    this.status = this.isActive === false ? "disabled" : "published";
  }
  next();
});

cosmeticSchema.statics.TYPE_TO_SLOT = TYPE_TO_SLOT;
cosmeticSchema.statics.RENDER_TYPES = RENDER_TYPES;
cosmeticSchema.statics.STATUSES = STATUSES;
cosmeticSchema.statics.defaultGamesForType = defaultGamesForType;

module.exports = mongoose.model("Cosmetic", cosmeticSchema);
