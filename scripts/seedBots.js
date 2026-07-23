require("dotenv").config();
const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const Player = require("../models/playerModel");
const BotSettings = require("../models/botSettingsModel");
const {
  BOT_SEEDS,
  AVATAR_CATALOG,
  THEME_CATALOG,
} = require("../config/botConfig");

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Idempotent seed for the 20-bot library. Bots are real User docs (isBot:true)
 * with a wallet (displayed balance only — never touched by settlement), a Player
 * stats doc so profiles look played-in, and a managed LOCAL avatar key. Re-running
 * updates identity fields but preserves existing balances/stats.
 */
async function seedBot(seed, index) {
  const email = `${seed.seedKey}@bots.local`;
  const avatarKey = AVATAR_CATALOG[index % AVATAR_CATALOG.length];
  const themeKey = THEME_CATALOG[index % THEME_CATALOG.length];
  // Staggered join dates so the roster looks organically aged.
  const createdAt = new Date(Date.now() - rand(30, 900) * 24 * 3600 * 1000);
  const lastOnline = new Date(Date.now() - rand(0, 180) * 60 * 1000);

  let user = await User.findOne({ "bot.seedKey": seed.seedKey });
  if (!user) {
    user = await User.create({
      name: seed.name,
      email,
      password: crypto.randomBytes(16).toString("hex"),
      country: seed.country,
      profileImg: avatarKey,
      isBot: true,
      createdAt,
      lastOnline,
      preferences: { language: seed.language || "ar", notifications: false },
      // A couple of veterans get VIP for variety.
      vip: index % 9 === 0 ? { active: true, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) } : undefined,
      bot: {
        seedKey: seed.seedKey,
        personality: seed.personality,
        skill: seed.skill,
        biography: seed.bio,
        avatarKey,
        themeKey,
        enabled: true,
        inUse: false,
        activity: "recently_online",
      },
    });
  } else {
    // Refresh identity (admin edits win; seed only fills identity, not balances).
    user.name = user.name || seed.name;
    user.isBot = true;
    user.profileImg = user.profileImg || avatarKey;
    user.bot = {
      ...(user.bot ? user.bot.toObject?.() || user.bot : {}),
      seedKey: seed.seedKey,
      personality: user.bot?.personality || seed.personality,
      skill: user.bot?.skill || seed.skill,
      biography: user.bot?.biography || seed.bio,
      avatarKey: user.bot?.avatarKey || avatarKey,
      themeKey: user.bot?.themeKey || themeKey,
      enabled: user.bot?.enabled !== false,
      inUse: false,
    };
    await user.save();
  }

  // Displayed wallet balance (identity only — settlement never moves it).
  const existingWallet = await Wallet.findOne({ user: user._id });
  if (!existingWallet) {
    await Wallet.create({ user: user._id, balance: rand(500, 50000) * 1000, lockedBalance: 0 });
    await User.updateOne({ _id: user._id }, { $set: { wallet: (await Wallet.findOne({ user: user._id }))._id } });
  }

  // Seeded, played-in stats so profiles look like long-term players.
  const player = await Player.getOrCreateByUser(user._id);
  if (!player.stats || !player.stats.gamesPlayed) {
    const games = rand(50, 4000);
    const wins = Math.floor(games * (0.35 + Math.random() * 0.3));
    player.displayName = seed.name;
    player.avatar = avatarKey;
    player.stats.gamesPlayed = games;
    player.stats.wins = wins;
    player.stats.level = Math.max(1, Math.floor(games / 60) + 1);
    player.stats.experience = games * rand(20, 120);
    await player.save();
  }

  return user._id;
}

async function main() {
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI_MISSING");
  await mongoose.connect(uri);
  try {
    await BotSettings.getDefaults();
    let created = 0;
    for (let i = 0; i < BOT_SEEDS.length; i++) {
      const before = await User.countDocuments({ "bot.seedKey": BOT_SEEDS[i].seedKey });
      await seedBot(BOT_SEEDS[i], i);
      if (!before) created += 1;
    }
    const total = await User.countDocuments({ isBot: true });
    console.log("bots_seeded", { catalog: BOT_SEEDS.length, created, totalBots: total });
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("seedBots failed:", err?.message || err);
  process.exit(1);
});
