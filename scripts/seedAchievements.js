/**
 * Seed 100+ achievements — run: node scripts/seedAchievements.js
 */
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Achievement = require("../models/achievementModel");
const dbConnection = require("../config/database");

dotenv.config();

const CATEGORIES = {
  poker: ["FIRST_WIN", "HAND_WON", "WIN_WITHOUT_SHOWDOWN", "ROYAL_FLUSH", "STRAIGHT_FLUSH", "FOUR_OF_A_KIND", "FULL_HOUSE"],
  social: ["FIRST_FRIEND", "CHAT_MASTER", "INVITE_SENT", "LOBBY_REGULAR"],
  tournament: ["FIRST_TOURNAMENT", "TOURNAMENT_WIN", "FINAL_TABLE", "HEADS_UP_WIN"],
  streak: ["WIN_STREAK_3", "WIN_STREAK_5", "WIN_STREAK_10"],
  volume: ["HANDS_100", "HANDS_500", "HANDS_1000", "HANDS_5000", "HANDS_10000"],
  profit: ["PROFIT_1K", "PROFIT_10K", "PROFIT_100K"],
  trix: ["TRIX_FIRST_WIN", "TRIX_KING", "TRIX_PERFECT"],
  tarneeb: ["TARNEEB_FIRST_WIN", "TARNEEB_BID_MASTER", "TARNEEB_SWEEP"],
  seasonal: ["SPRING_2026", "SUMMER_2026", "AUTUMN_2026", "WINTER_2026"],
  hidden: ["LUCKY_SEVEN", "MIDNIGHT_PLAYER", "COMEBACK_KID"],
};

function buildAchievements() {
  const list = [];
  let id = 0;
  for (const [cat, codes] of Object.entries(CATEGORIES)) {
    for (const code of codes) {
      list.push({
        code,
        title: code.replace(/_/g, " "),
        description: `${cat} achievement: ${code}`,
        points: 10 + (id % 50),
        icon: `achievement_${cat}`,
        isActive: true,
        hidden: cat === "hidden",
        category: cat,
      });
      id++;
    }
  }
  for (let i = 1; i <= 80; i++) {
    list.push({
      code: `MILESTONE_${i}`,
      title: `Milestone ${i}`,
      description: `Reach milestone level ${i}`,
      points: i,
      icon: "achievement_milestone",
      isActive: true,
      category: "milestone",
    });
  }
  return list;
}

async function seed() {
  await dbConnection();
  const achievements = buildAchievements();
  let upserted = 0;
  for (const a of achievements) {
    await Achievement.findOneAndUpdate({ code: a.code }, { $set: a }, { upsert: true });
    upserted++;
  }
  console.log(`Seeded ${upserted} achievements`);
  await mongoose.disconnect();
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
