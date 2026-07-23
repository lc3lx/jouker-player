require("dotenv").config();
const mongoose = require("mongoose");
const ClanSettings = require("../models/clanSettingsModel");
const ClanAchievementDef = require("../models/clanAchievementDefModel");

/** Starter data-driven achievement catalog (admin can add more without code). */
const STARTER_ACHIEVEMENTS = [
  { key: "first_tournament", title: "أول بطولة", description: "أكمل أول بطولة للعشيرة", icon: "flag", criteria: { metric: "tournamentWins", op: "gte", threshold: 1 }, rewardCoins: 100000, sortOrder: 1 },
  { key: "wins_100", title: "100 فوز", description: "حقق 100 فوز جماعي", icon: "medal", criteria: { metric: "wins", op: "gte", threshold: 100 }, rewardCoins: 500000, sortOrder: 2 },
  { key: "champion", title: "البطل", description: "افز بـ 10 بطولات", icon: "crown", criteria: { metric: "tournamentWins", op: "gte", threshold: 10 }, rewardCoins: 1000000, sortOrder: 3 },
  { key: "top_10", title: "أفضل 10", description: "ادخل ضمن أفضل 10 عشائر", icon: "star", criteria: { metric: "rankScore", op: "gte", threshold: 10000 }, rewardCoins: 2000000, sortOrder: 4 },
];

async function main() {
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI_MISSING");
  await mongoose.connect(uri);
  try {
    const settings = await ClanSettings.getDefaults();
    console.log("clan_settings_seeded", {
      key: settings.key,
      creationCost: settings.creationCost,
      maxMembersDefault: settings.maxMembersDefault,
    });

    let created = 0;
    for (const def of STARTER_ACHIEVEMENTS) {
      const res = await ClanAchievementDef.updateOne(
        { key: def.key },
        { $setOnInsert: def },
        { upsert: true }
      );
      if (res.upsertedCount) created += 1;
    }
    console.log("clan_achievement_defs_seeded", { total: STARTER_ACHIEVEMENTS.length, created });
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("seedClanSettings failed:", err?.message || err);
  process.exit(1);
});
