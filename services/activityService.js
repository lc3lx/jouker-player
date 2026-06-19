const asyncHandler = require("express-async-handler");
const Activity = require("../models/activityModel");
const Player = require("../models/playerModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Table = require("../models/tableModel");

const FEED_CATEGORIES = {
  all: null,
  win: ["win"],
  task: ["task", "bonus"],
};

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function formatAmountSigned(value) {
  const n = Math.floor(Number(value) || 0);
  if (n === 0) return "";
  const abs = Math.abs(n).toLocaleString("en-US");
  return n > 0 ? `+${abs}` : `-${abs}`;
}

function relativeAgeLabel(date, now = new Date()) {
  const ms = now.getTime() - new Date(date).getTime();
  if (ms < 0) return "الآن";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `منذ ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "منذ ساعة" : `منذ ${hours} ساعة`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "أمس";
  if (days < 7) return `منذ ${days} أيام`;
  return new Date(date).toLocaleDateString("ar-SA");
}

function formatTableLabel(table) {
  if (!table) return "طاولة";
  const tierLabels = {
    beginner: "المبتدئين",
    intermediate: "المتوسط",
    beast: "المحترفين",
    private: "خاصة",
  };
  const tier = tierLabels[table.tier] || table.tier || "";
  return tier ? `طاولة ${tier}` : "طاولة";
}

function mapTxToActivity(tx, tableName) {
  const amount = Math.floor(Number(tx.amount) || 0);
  const meta = tx.meta || {};
  const tableLabel = tableName || meta.tableName || "طاولة";

  if (tx.type === "win") {
    return {
      category: "win",
      label: `فزت في ${tableLabel}`,
      subLabel: `${tableLabel} · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "trophy",
    };
  }

  if (tx.type === "bet") {
    return {
      category: "loss",
      label: `خسرت في ${tableLabel}`,
      subLabel: `${tableLabel} · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "loss",
    };
  }

  if (meta.source === "daily_bonus") {
    return {
      category: "bonus",
      label: "حصلت على مكافأة الحضور اليومي",
      subLabel: `المكافآت اليومية · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  if (tx.type === "recharge" || tx.type === "deposit" || tx.type === "confirmed_deposit") {
    return {
      category: "bonus",
      label: "تم شحن الرصيد",
      subLabel: `المحفظة · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  if (tx.type === "cosmetic_purchase") {
    return {
      category: "other",
      label: meta.itemName ? `اشتريت ${meta.itemName}` : "شراء من المتجر",
      subLabel: `المتجر · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "star",
    };
  }

  if (tx.type === "withdraw" || tx.type === "completed_withdraw") {
    return {
      category: "other",
      label: "سحب من المحفظة",
      subLabel: `المحفظة · ${relativeAgeLabel(tx.createdAt)}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "default",
    };
  }

  return null;
}

async function resolveTableNames(tableIds) {
  const ids = [...new Set(tableIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await Table.find({ _id: { $in: ids } }).select("tier gameType tableNumber").lean();
  const map = {};
  for (const row of rows) {
    map[String(row._id)] = formatTableLabel(row);
  }
  return map;
}

async function recordActivityFromTransaction(tx) {
  if (!tx?.userId) return;
  const sourceId = String(tx._id || "");
  if (!sourceId) return;

  const existing = await Activity.findOne({
    userId: tx.userId,
    sourceType: "wallet_tx",
    sourceId,
  }).lean();
  if (existing) return;

  let tableName = null;
  if (tx.tableId) {
    const table = await Table.findById(tx.tableId).select("tier gameType tableNumber").lean();
    tableName = formatTableLabel(table);
  }

  const mapped = mapTxToActivity(tx, tableName);
  if (!mapped) return;

  try {
    await Activity.create({
      userId: tx.userId,
      ...mapped,
      sourceType: "wallet_tx",
      sourceId,
      meta: { txType: tx.type, tableId: tx.tableId || null, handId: tx.handId || null },
      createdAt: tx.createdAt || new Date(),
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

async function backfillActivities(userId, limit = 50) {
  const txs = await WalletTransaction.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const tableIds = txs.map((t) => t.tableId).filter(Boolean);
  const tableNames = await resolveTableNames(tableIds);

  for (const tx of txs) {
    const sourceId = String(tx._id);
    const exists = await Activity.findOne({
      userId,
      sourceType: "wallet_tx",
      sourceId,
    }).lean();
    if (exists) continue;

    const tableName = tx.tableId ? tableNames[String(tx.tableId)] : null;
    const mapped = mapTxToActivity(tx, tableName);
    if (!mapped) continue;

    try {
      await Activity.create({
        userId,
        ...mapped,
        sourceType: "wallet_tx",
        sourceId,
        meta: { txType: tx.type, tableId: tx.tableId || null, handId: tx.handId || null },
        createdAt: tx.createdAt || new Date(),
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
}

async function buildDailyTasks(user) {
  const { buildDailyTasksPreview } = require("./taskService");
  const data = await buildDailyTasksPreview(user._id);
  return {
    tasks: data.tasks.map((t) => ({
      id: t.id,
      label: t.title,
      reward: String(t.chipsReward),
      icon: t.icon,
      done: t.isCompleted,
      progress: t.progress,
      current: t.currentProgress,
      target: t.targetProgress,
    })),
    completed: data.completed,
    total: data.total,
  };
}

async function buildWeeklyPnL(userId) {
  const now = new Date();
  const since = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const dayStart = startOfUtcDay(since);

  const rows = await WalletTransaction.aggregate([
    {
      $match: {
        userId,
        type: { $in: ["win", "bet"] },
        createdAt: { $gte: dayStart },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
        },
        wins: { $sum: { $cond: [{ $eq: ["$type", "win"] }, "$amount", 0] } },
        losses: { $sum: { $cond: [{ $eq: ["$type", "bet"] }, "$amount", 0] } },
      },
    },
  ]);

  const byDay = {};
  for (const row of rows) {
    byDay[row._id] = (row.wins || 0) - (row.losses || 0);
  }

  const arabicDays = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];
  const days = [];
  let maxAbs = 1;

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const net = byDay[key] || 0;
    maxAbs = Math.max(maxAbs, Math.abs(net));
    const label = i === 0 ? "اليوم" : arabicDays[d.getUTCDay()];
    days.push({ date: key, label, net, wins: net > 0 ? net : 0, losses: net < 0 ? Math.abs(net) : 0 });
  }

  const barMaxHeight = 42;
  return days.map((day) => ({
    ...day,
    barHeight: Math.max(4, Math.round((Math.abs(day.net) / maxAbs) * barMaxHeight)),
    positive: day.net >= 0,
  }));
}

exports.recordActivityFromTransaction = recordActivityFromTransaction;

exports.recordActivity = async (payload) => {
  const { userId, sourceType, sourceId } = payload;
  if (sourceType && sourceId) {
    const existing = await Activity.findOne({ userId, sourceType, sourceId }).lean();
    if (existing) return existing;
  }
  try {
    return await Activity.create(payload);
  } catch (err) {
    if (err?.code === 11000) {
      return Activity.findOne({ userId, sourceType, sourceId }).lean();
    }
    throw err;
  }
};

exports.getActivitiesFeed = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  await backfillActivities(userId);

  const filter = (req.query.filter || "all").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
  const skip = (page - 1) * limit;

  const query = { userId };
  const cats = FEED_CATEGORIES[filter];
  if (cats) query.category = { $in: cats };

  const [rows, total] = await Promise.all([
    Activity.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Activity.countDocuments(query),
  ]);

  const now = new Date();
  res.status(200).json({
    status: "success",
    results: rows.length,
    pagination: {
      currentPage: page,
      limit,
      total,
      numberOfPages: Math.ceil(total / limit) || 1,
      next: page * limit < total ? page + 1 : null,
    },
    data: rows.map((row) => ({
      id: row._id,
      category: row.category,
      label: row.label,
      subLabel: row.subLabel,
      amountDisplay: row.amountDisplay,
      amountValue: row.amountValue,
      icon: row.icon,
      ageLabel: relativeAgeLabel(row.createdAt, now),
      createdAt: row.createdAt,
    })),
  });
});

exports.getActivitiesSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  await backfillActivities(userId);

  const [user, player, wallet] = await Promise.all([
    User.findById(userId).select(
      "name pokerHandsPlayed pokerHandsWon pokerWinStreak lastDailyBonusAt dailyBonusStreak"
    ),
    Player.getOrCreateByUser(userId),
    Wallet.findOne({ user: userId }).lean(),
  ]);

  const s = player.stats || {};
  const gamesPlayed = s.gamesPlayed || user?.pokerHandsPlayed || 0;
  const wins = s.wins || user?.pokerHandsWon || 0;
  const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const bestWinRow = await WalletTransaction.findOne({
    userId,
    type: "win",
    createdAt: { $gte: since },
  })
    .sort({ amount: -1 })
    .lean();
  const bestProfit = bestWinRow?.amount || s.bestScore || 0;

  const leaderboardRows = await WalletTransaction.aggregate([
    { $match: { type: "win", createdAt: { $gte: since } } },
    { $group: { _id: "$userId", totalWon: { $sum: "$amount" } } },
    { $sort: { totalWon: -1 } },
    { $limit: 5 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "u",
      },
    },
    { $unwind: "$u" },
    {
      $project: {
        userId: "$_id",
        name: "$u.name",
        profileImg: "$u.profileImg",
        totalWon: 1,
      },
    },
  ]);

  const myRankIndex = leaderboardRows.findIndex((r) => String(r.userId) === String(userId));
  const dailyTasks = await buildDailyTasks(user);
  const weeklyPnL = await buildWeeklyPnL(userId);
  const level = s.level || 1;
  const experience = s.experience || 0;
  const xpPerLevel = 2500;
  const xpInLevel = experience % xpPerLevel;
  const xpProgress = xpInLevel / xpPerLevel;

  res.status(200).json({
    status: "success",
    data: {
      balance: wallet?.balance || 0,
      userName: user?.name || "Player",
      stats: {
        winRate,
        wins,
        gamesPlayed,
        bestProfit,
        level,
        experience,
        xpProgress,
        xpInLevel,
        xpPerLevel,
      },
      leaderboard: leaderboardRows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        name: r.name || "Player",
        profileImg: r.profileImg || "",
        score: r.totalWon || 0,
        isMe: String(r.userId) === String(userId),
      })),
      myLeaderboardRank: myRankIndex >= 0 ? myRankIndex + 1 : null,
      dailyTasks,
      weeklyPnL,
    },
  });
});
