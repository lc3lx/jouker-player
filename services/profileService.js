const asyncHandler = require("express-async-handler");
const User = require("../models/userModel");
const Player = require("../models/playerModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Achievement = require("../models/achievementModel");
const Table = require("../models/tableModel");

const XP_PER_LEVEL = 2500;

const GAME_LABELS = {
  poker: "بوكر تكساس",
  trix: "تركس",
  tarneeb41: "طرنيب 41",
  tarneeb: "طرنيب",
};

const TIER_LABELS = {
  beginner: "المبتدئين",
  intermediate: "المتوسط",
  beast: "المحترفين",
  private: "خاصة",
};

function formatTableLabel(table) {
  if (!table) return "طاولة";
  const game = GAME_LABELS[table.gameType] || "لعبة";
  const tier = TIER_LABELS[table.tier];
  return tier ? `${game} · ${tier}` : game;
}

function formatAmountSigned(value) {
  const n = Math.floor(Number(value) || 0);
  if (n === 0) return "0";
  const abs = Math.abs(n).toLocaleString("en-US");
  return n > 0 ? `+${abs}` : `-${abs}`;
}

function formatCompact(n) {
  const v = Math.floor(Number(n) || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(v);
}

function relativeAgeLabel(date, now = new Date()) {
  const ms = now.getTime() - new Date(date).getTime();
  if (ms < 0) return "الآن";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return mins === 1 ? "منذ دقيقة" : `منذ ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "منذ ساعة" : `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "أمس";
  if (days < 7) return `منذ ${days} أيام`;
  if (days < 14) return "منذ أسبوع";
  return `منذ ${Math.floor(days / 7)} أسابيع`;
}

function buildComputedBadges({ wins, winStreak, dailyBonusStreak, bestProfit, winRate }) {
  const defs = [
    { id: "streak", label: "متسلسل", icon: "fire", unlocked: winStreak >= 3 },
    { id: "winner", label: "بطل البطولة", icon: "trophy", unlocked: wins >= 10 },
    { id: "attendance", label: "حضور", icon: "gift", unlocked: dailyBonusStreak >= 5 },
    { id: "profit", label: "ملك الطاولة", icon: "crown", unlocked: bestProfit >= 50000 },
    { id: "accurate", label: "دقيق", icon: "target", unlocked: winRate >= 0.55 && wins >= 20 },
    { id: "diamond", label: "ماسي", icon: "diamond", unlocked: wins >= 100 },
  ];
  return defs.map((b) => ({ ...b, color: b.unlocked ? "gold" : "muted" }));
}

async function resolveTableLabels(tableIds) {
  const ids = [...new Set(tableIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await Table.find({ _id: { $in: ids } }).select("tier gameType tableNumber").lean();
  const map = {};
  for (const row of rows) map[String(row._id)] = formatTableLabel(row);
  return map;
}

exports.getProfileSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const [user, player, wallet, txs, bestWinRow, dbAchievements] = await Promise.all([
    User.findById(userId).select(
      "name email country profileImg pokerHandsPlayed pokerHandsWon pokerWinStreak dailyBonusStreak createdAt"
    ),
    Player.getOrCreateByUser(userId),
    Wallet.findOne({ user: userId }).lean(),
    WalletTransaction.find({ userId, type: { $in: ["win", "bet"] } })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    WalletTransaction.findOne({ userId, type: "win" }).sort({ amount: -1 }).lean(),
    Achievement.find({ isActive: { $ne: false } }).limit(12).lean(),
  ]);

  if (!user) {
    return res.status(404).json({ status: "error", message: "User not found" });
  }

  await player.populate({ path: "achievements", select: "title description icon code points" });

  const s = player.stats || {};
  const wins = Math.max(s.wins || 0, user.pokerHandsWon || 0);
  const gamesPlayed = Math.max(s.gamesPlayed || 0, user.pokerHandsPlayed || 0);
  const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;
  const bestProfit = bestWinRow?.amount || s.bestScore || 0;
  const level = s.level || 1;
  const experience = s.experience || 0;
  const xpInLevel = experience % XP_PER_LEVEL;
  const xpProgress = xpInLevel / XP_PER_LEVEL;
  const dailyBonusStreak = user.dailyBonusStreak || 0;
  const winStreak = user.pokerWinStreak || 0;

  const tableLabels = await resolveTableLabels(txs.map((t) => t.tableId));
  const now = new Date();

  const matchHistory = txs.map((tx) => {
    const tableLabel = tx.tableId ? tableLabels[String(tx.tableId)] || "طاولة" : "طاولة";
    const isWin = tx.type === "win";
    return {
      id: String(tx._id),
      game: tableLabel.split(" · ")[0] || "لعبة",
      subtitle: `${tableLabel} · ${relativeAgeLabel(tx.createdAt, now)}`,
      amountDisplay: formatAmountSigned(isWin ? tx.amount : -tx.amount),
      isWin,
      createdAt: tx.createdAt,
    };
  });

  const unlockedCodes = new Set((player.achievements || []).map((a) => a.code));
  const achievementBadges = (player.achievements || []).slice(0, 6).map((a) => ({
    id: a.code,
    label: a.title,
    icon: a.icon || "star",
    unlocked: true,
    color: "gold",
  }));

  let badges = achievementBadges;
  if (badges.length < 6) {
    const computed = buildComputedBadges({ wins, winStreak, dailyBonusStreak, bestProfit, winRate });
    for (const b of computed) {
      if (badges.length >= 6) break;
      if (!badges.some((x) => x.id === b.id)) badges.push(b);
    }
  }

  const statsCards = [
    { icon: "fire", value: String(dailyBonusStreak), label: "أيام متتالية", color: "#FF6B35" },
    { icon: "trophy", value: "0", label: "البطولات", color: "#FFD36A" },
    { icon: "friends", value: "0", label: "الأصدقاء", color: "#5BC8FF" },
    { icon: "profit", value: formatCompact(bestProfit), label: "أكبر ربح", color: "#FFC400" },
    { icon: "wins", value: String(wins), label: "إجمالي الفوز", color: "#FFD36A" },
    { icon: "rate", value: `${Math.round(winRate * 100)}%`, label: "معدل الفوز", color: "#7BE495" },
  ];

  const shortId = String(user._id).slice(-5).toUpperCase();

  res.status(200).json({
    status: "success",
    data: {
      user: {
        id: user._id,
        shortId,
        name: user.name,
        email: user.email,
        country: user.country || "",
        profileImg: user.profileImg || "",
        memberSince: user.createdAt,
      },
      balance: wallet?.balance || 0,
      level,
      experience,
      xpPerLevel: XP_PER_LEVEL,
      xpProgress,
      xpInLevel,
      summary: {
        wins,
        gamesPlayed,
        winRate,
        bestProfit,
        dailyBonusStreak,
        winStreak,
      },
      statsCards,
      badges,
      matchHistory,
      achievementsCatalogCount: dbAchievements.length,
      isVip: dailyBonusStreak >= 7 || level >= 10,
    },
  });
});
