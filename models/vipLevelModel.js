const mongoose = require("mongoose");

/**
 * VIP levels — admin-managed, UNLIMITED. Replaces the hardcoded 4-level config
 * in config/vipConfig.js. Existing subscriptions store `currentLevel` as a stable
 * string `key`, so the 4 defaults keep their keys (bronze/silver/gold/platinum)
 * and new levels are just new keys — no migration of member data required.
 *
 * `benefits` mirrors the reward math the VIP engine already uses (cashback / daily
 * chips / quiz / queue priority) so vipLevelRegistry can flatten a level into the
 * exact shape config/vipConfig.js used to return.
 */
const vipLevelBenefitsSchema = new mongoose.Schema(
  {
    cashbackPercent: { type: Number, default: 0 },
    weeklyCashbackCapChips: { type: Number, default: 0 },
    dailyChips: { type: Number, default: 0 },
    quiz: { type: Boolean, default: false },
    priorityQueue: { type: Boolean, default: false },
    queueBoostMs: { type: Number, default: 0 },
  },
  { _id: false }
);

const vipLevelSchema = new mongoose.Schema(
  {
    /** Stable key stored on subscriptions (e.g. "bronze"). NEVER changes. */
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    nameAr: { type: String, default: null },
    description: { type: String, default: null },
    /** Rank used for upgrade/downgrade + queue priority (higher = better). */
    priority: { type: Number, required: true, default: 1, index: true },

    // presentation (data-driven — Flutter renders these)
    badge: { type: String, default: null },
    color: { type: String, default: null },
    icon: { type: String, default: null },
    background: { type: String, default: null },
    preview: { type: String, default: null },

    // pricing — VIP stays real-money (USD via IAP / agents)
    priceUsd: { type: Number, default: 0 },
    priceCents: { type: Number, default: 0 },
    currency: { type: String, default: "usd" },
    durationDays: { type: Number, default: 30 },
    freeTrialDays: { type: Number, default: 0 },
    autoRenewDefault: { type: Boolean, default: true },
    promo: { type: mongoose.Schema.Types.Mixed, default: null },

    benefits: { type: vipLevelBenefitsSchema, default: () => ({}) },

    enabled: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Seed the 4 legacy levels from the built-in config so nothing changes on day one. */
vipLevelSchema.statics.ensureDefaults = async function ensureDefaults() {
  // Lazy require avoids any load-order coupling with the registry.
  const { VIP_LEVELS, VIP_LEVEL_CONFIG } = require("../config/vipConfig");
  const existing = await this.find({}).select("key").lean();
  const have = new Set(existing.map((d) => d.key));
  const rows = [];
  let order = 0;
  for (const key of VIP_LEVELS) {
    order += 1;
    if (have.has(key)) continue;
    const c = VIP_LEVEL_CONFIG[key];
    rows.push({
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      priority: c.rank,
      priceUsd: c.priceUsd,
      priceCents: c.priceCents,
      currency: "usd",
      durationDays: 30,
      sortOrder: order,
      benefits: {
        cashbackPercent: c.cashbackPercent,
        weeklyCashbackCapChips: c.weeklyCashbackCapChips,
        dailyChips: c.dailyChips,
        quiz: c.quiz,
        priorityQueue: c.priorityQueue,
        queueBoostMs: c.queueBoostMs,
      },
    });
  }
  if (rows.length > 0) await this.insertMany(rows, { ordered: false });
  return rows.length;
};

module.exports = mongoose.model("VipLevel", vipLevelSchema);
