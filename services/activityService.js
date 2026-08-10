const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const Activity = require("../models/activityModel");
const Player = require("../models/playerModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const Table = require("../models/tableModel");
const {
  XP_PER_LEVEL,
} = require("../modules/playerProgress/config/playerProgressConfig");

const FEED_CATEGORIES = {
  all: null,
  win: ["win"],
  loss: ["loss"],
  task: ["task", "bonus"],
};

/** Aligned with playerProfileService — systematic win/loss for stats & charts. */
const WIN_TX_TYPES = ["win", "game_win", "island_jackpot_win"];
const LOSS_TX_TYPES = ["game_loss", "bet", "game_buyin"];

// #region agent log
function agentActLog(hypothesisId, message, data) {
  try {
    fs.appendFileSync(
      path.join("D:", "work", "play", "debug-9f6022.log"),
      `${JSON.stringify({
        sessionId: "9f6022",
        hypothesisId,
        location: "activityService.js",
        message,
        data,
        timestamp: Date.now(),
        runId: "activities-fix",
      })}\n`
    );
  } catch (_) {}
}
// #endregion

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
  const gameLabels = {
    poker: "بوكر",
    trix: "تركس",
    tarneeb41: "طرنيب",
  };
  const tierLabels = {
    beginner: "المبتدئين",
    intermediate: "المتوسط",
    beast: "المحترفين",
    private: "خاصة",
  };
  const game = gameLabels[table.gameType] || "";
  const tier = tierLabels[table.tier] || table.tier || "";
  if (game && tier) return `${game} · ${tier}`;
  if (game) return game;
  return tier ? `طاولة ${tier}` : "طاولة";
}

function mapTxToActivity(tx, tableName) {
  const amount = Math.floor(Number(tx.amount) || 0);
  const meta = tx.meta || {};
  const tableLabel = tableName || meta.tableName || "طاولة";
  const age = relativeAgeLabel(tx.createdAt);

  if (tx.type === "win" || tx.type === "game_win" || tx.type === "island_jackpot_win") {
    return {
      category: "win",
      label: `فزت في ${tableLabel}`,
      subLabel: `${tableLabel} · ${age}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "trophy",
    };
  }

  // Real loss (mini-games / settlement loss) — NOT a table buy-in/bet.
  if (tx.type === "game_loss") {
    return {
      category: "loss",
      label: `خسرت في ${tableLabel}`,
      subLabel: `${tableLabel} · ${age}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "loss",
    };
  }

  // Poker/card buy-in or ante — spending chips to play, not a "loss" result.
  if (tx.type === "bet" || tx.type === "game_buyin") {
    const isBuyIn = tx.type === "game_buyin";
    return {
      category: "other",
      label: isBuyIn ? `دخول ${tableLabel}` : `رهان في ${tableLabel}`,
      subLabel: `${tableLabel} · ${age}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "coins",
    };
  }

  if (tx.type === "refund") {
    return {
      category: "bonus",
      label: `استرداد من ${tableLabel}`,
      subLabel: `${tableLabel} · ${age}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  if (meta.source === "daily_bonus") {
    return {
      category: "bonus",
      label: "حصلت على مكافأة الحضور اليومي",
      subLabel: `المكافآت اليومية · ${age}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  if (tx.type === "recharge" || tx.type === "deposit" || tx.type === "confirmed_deposit") {
    return {
      category: "bonus",
      label: "تم شحن الرصيد",
      subLabel: `المحفظة · ${age}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  if (tx.type === "cosmetic_purchase" || tx.type === "interaction_purchase") {
    return {
      category: "other",
      label: meta.itemName ? `اشتريت ${meta.itemName}` : "شراء من المتجر",
      subLabel: `المتجر · ${age}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "star",
    };
  }

  if (tx.type === "withdraw" || tx.type === "completed_withdraw") {
    return {
      category: "other",
      label: "سحب من المحفظة",
      subLabel: `المحفظة · ${age}`,
      amountDisplay: formatAmountSigned(-amount),
      amountValue: -amount,
      icon: "default",
    };
  }

  if (tx.type === "referral_reward" || tx.type === "gift_received") {
    return {
      category: "bonus",
      label: tx.type === "referral_reward" ? "مكافأة إحالة" : "هدية مستلمة",
      subLabel: `المكافآت · ${age}`,
      amountDisplay: formatAmountSigned(amount),
      amountValue: amount,
      icon: "gift",
    };
  }

  return null;
}

/** Fix historical rows that wrongly marked bets as losses. */
async function repairMislabelledBetActivities(userId) {
  const bad = await Activity.find({
    userId,
    category: "loss",
    "meta.txType": { $in: ["bet", "game_buyin"] },
  })
    .limit(200)
    .exec();

  let fixed = 0;
  for (const row of bad) {
    const isBuyIn = row.meta?.txType === "game_buyin";
    const nextLabel = String(row.label || "").replace(/^خسرت في/, isBuyIn ? "دخول" : "رهان في");
    row.category = "other";
    row.label = nextLabel;
    row.icon = "coins";
    await row.save();
    fixed += 1;
  }
  return fixed;
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
      const created = await Activity.create({
        userId: tx.userId,
        ...mapped,
        sourceType: "wallet_tx",
        sourceId,
        meta: { txType: tx.type, tableId: tx.tableId || null, handId: tx.handId || null },
        createdAt: tx.createdAt || new Date(),
      });
      const { recordNotificationFromActivity } = require("./notificationService");
      recordNotificationFromActivity(created.toObject?.() || created).catch(() => {});
    } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

async function backfillActivities(userId, limit = 50) {
  await repairMislabelledBetActivities(userId);

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
        type: { $in: [...WIN_TX_TYPES, ...LOSS_TX_TYPES] },
        createdAt: { $gte: dayStart },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "UTC" },
        },
        wins: {
          $sum: {
            $cond: [{ $in: ["$type", WIN_TX_TYPES] }, "$amount", 0],
          },
        },
        losses: {
          $sum: {
            $cond: [{ $in: ["$type", LOSS_TX_TYPES] }, "$amount", 0],
          },
        },
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
  let weekNet = 0;

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    const net = byDay[key] || 0;
    weekNet += net;
    maxAbs = Math.max(maxAbs, Math.abs(net));
    const label = i === 0 ? "اليوم" : arabicDays[d.getUTCDay()];
    days.push({
      date: key,
      label,
      net,
      wins: net > 0 ? net : 0,
      losses: net < 0 ? Math.abs(net) : 0,
    });
  }

  const barMaxHeight = 42;
  return {
    weekNet,
    days: days.map((day) => ({
      ...day,
      barHeight: Math.max(4, Math.round((Math.abs(day.net) / maxAbs) * barMaxHeight)),
      positive: day.net >= 0,
    })),
  };
}

exports.recordActivityFromTransaction = recordActivityFromTransaction;

exports.recordActivity = async (payload) => {
  const { userId, sourceType, sourceId } = payload;
  if (sourceType && sourceId) {
    const existing = await Activity.findOne({ userId, sourceType, sourceId }).lean();
    if (existing) return existing;
  }
  try {
    const created = await Activity.create(payload);
    const { recordNotificationFromActivity } = require("./notificationService");
    recordNotificationFromActivity(created.toObject?.() || created).catch(() => {});
    return created;
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
  const data = rows.map((row) => ({
    id: row._id,
    category: row.category,
    label: row.label,
    subLabel: row.subLabel,
    amountDisplay: row.amountDisplay,
    amountValue: row.amountValue,
    icon: row.icon,
    ageLabel: relativeAgeLabel(row.createdAt, now),
    createdAt: row.createdAt,
  }));

  // #region agent log
  const catCounts = {};
  for (const row of data) {
    catCounts[row.category] = (catCounts[row.category] || 0) + 1;
  }
  agentActLog("H-F1", "activities feed filtered", {
    filter,
    total,
    returned: data.length,
    catCounts,
    queryCats: cats || "all",
  });
  // #endregion

  res.status(200).json({
    status: "success",
    results: data.length,
    pagination: {
      currentPage: page,
      limit,
      total,
      numberOfPages: Math.ceil(total / limit) || 1,
      next: page * limit < total ? page + 1 : null,
    },
    data,
  });
});

exports.getActivitiesSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  await backfillActivities(userId);

  const [user, player, wallet] = await Promise.all([
    User.findById(userId).select(
      "name profileImg pokerHandsPlayed pokerHandsWon pokerWinStreak lastDailyBonusAt dailyBonusStreak"
    ),
    Player.getOrCreateByUser(userId),
    Wallet.findOne({ user: userId }).lean(),
  ]);

  const s = player.stats || {};
  // Prefer the higher of Player.stats vs User poker counters (same as profile).
  const gamesPlayed = Math.max(
    Math.floor(Number(s.gamesPlayed) || 0),
    Math.floor(Number(user?.pokerHandsPlayed) || 0)
  );
  const wins = Math.max(
    Math.floor(Number(s.wins) || 0),
    Math.floor(Number(user?.pokerHandsWon) || 0)
  );
  const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const bestWinRow = await WalletTransaction.findOne({
    userId,
    type: { $in: WIN_TX_TYPES },
    createdAt: { $gte: since },
  })
    .sort({ amount: -1 })
    .lean();
  const bestProfit = Math.floor(Number(bestWinRow?.amount) || Number(s.bestScore) || 0);

  const leaderboardRows = await WalletTransaction.aggregate([
    { $match: { type: { $in: WIN_TX_TYPES }, createdAt: { $gte: since } } },
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
  const weekly = await buildWeeklyPnL(userId);
  const experience = Math.floor(Number(s.experience) || 0);
  const level = Math.max(1, Math.floor(Number(s.level) || 1));
  const xpPerLevel = XP_PER_LEVEL;
  const xpInLevel = experience % xpPerLevel;
  const xpProgress = xpPerLevel > 0 ? xpInLevel / xpPerLevel : 0;

  // #region agent log
  agentActLog("H-ACT-1", "activities summary computed", {
    gamesPlayed,
    wins,
    winRate: Math.round(winRate * 1000) / 1000,
    bestProfit,
    level,
    experience,
    xpInLevel,
    xpPerLevel,
    weekNet: weekly.weekNet,
    leaders: leaderboardRows.length,
    dailyTasksCompleted: dailyTasks.completed,
    dailyTasksTotal: dailyTasks.total,
    dailyTaskIds: (dailyTasks.tasks || []).map((t) => t.id),
    weeklyDays: (weekly.days || []).map((d) => ({ label: d.label, net: d.net })),
  });
  // #endregion

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
      weeklyPnL: weekly.days,
      weekNet: weekly.weekNet,
    },
  });
});
