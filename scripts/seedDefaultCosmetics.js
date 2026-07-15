/**
 * Inserts/updates starter catalog rows (idempotent by assetKey + type).
 * Usage: node scripts/seedDefaultCosmetics.js
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Cosmetic = require("../models/cosmeticModel");
const DEFAULT_CATALOG = require("../data/defaultCosmeticsCatalog");

async function main() {
  const uri = process.env.DATABASE_URL || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/play";
  await mongoose.connect(uri);

  for (const row of DEFAULT_CATALOG) {
    const { type, assetKey, ...rest } = row;
    await Cosmetic.updateOne(
      { type, assetKey },
      {
        $set: {
          type,
          assetKey,
          ...rest,
        },
      },
      { upsert: true }
    );
  }

  // Deactivate legacy frames that are no longer sold
  await Cosmetic.updateMany(
    { type: "avatar_frame", assetKey: { $in: ["royal", "silver"] } },
    { $set: { isActive: false } }
  );

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
  const skins = await Cosmetic.countDocuments({
    type: "avatar_frame",
    assetKey: /^skin_/,
    isActive: true,
  });
  console.log(`Cosmetics catalog synced. Total: ${n}, country skins: ${skins}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
