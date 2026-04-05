/**
 * Inserts starter catalog rows (idempotent by assetKey + type).
 * Usage: node scripts/seedDefaultCosmetics.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Cosmetic = require("../models/cosmeticModel");

const CATALOG = [
  {
    type: "table_theme",
    name: "Classic Green",
    assetKey: "default",
    price: 0,
    rarity: "common",
    isActive: true,
  },
  {
    type: "table_theme",
    name: "Midnight Royal",
    assetKey: "midnight_royal",
    price: 2500,
    rarity: "rare",
    isActive: true,
  },
  {
    type: "table_theme",
    name: "Burgundy Velvet",
    assetKey: "burgundy_velvet",
    price: 5000,
    rarity: "epic",
    isActive: true,
  },
  {
    type: "card_skin",
    name: "Standard Deck",
    assetKey: "default",
    price: 0,
    rarity: "common",
    isActive: true,
  },
  {
    type: "card_skin",
    name: "Ruby Back",
    assetKey: "ruby",
    price: 1500,
    rarity: "rare",
    isActive: true,
    featured: true,
    featuredOrder: 2,
    promoMeta: {
      discountPercent: 15,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  },
];

async function main() {
  const uri = process.env.DATABASE_URL || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/play";
  await mongoose.connect(uri);
  for (const row of CATALOG) {
    await Cosmetic.updateOne(
      { type: row.type, assetKey: row.assetKey },
      { $setOnInsert: row },
      { upsert: true }
    );
  }
  const midnight = await Cosmetic.findOne({
    type: "table_theme",
    assetKey: "midnight_royal",
  }).select("_id");
  const ruby = await Cosmetic.findOne({ type: "card_skin", assetKey: "ruby" }).select("_id");
  if (midnight && ruby) {
    await Cosmetic.updateOne(
      { type: "bundle", assetKey: "starter_mogul_pack" },
      {
        $set: {
          type: "bundle",
          name: "Starter Mogul Pack",
          assetKey: "starter_mogul_pack",
          price: 3200,
          rarity: "rare",
          isActive: true,
          featured: true,
          featuredOrder: 0,
          promoMeta: {
            items: [midnight._id, ruby._id],
          },
        },
      },
      { upsert: true }
    );
  }
  const n = await Cosmetic.countDocuments();
  console.log(`Cosmetics catalog synced. Total documents: ${n}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
