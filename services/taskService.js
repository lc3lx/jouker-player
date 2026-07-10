const asyncHandler = require("express-async-handler");
const AnalyticsEvent = require("../models/analyticsEventModel");
const MiniGamePlay = require("../models/miniGamePlayModel");
const Player = require("../models/playerModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const UserTaskClaim = require("../models/userTaskClaimModel");
const ApiError = require("../utils/apiError");
const { withMongoTransaction, ledgerDeposit } = require("./walletLedgerService");
const playerProgressService = require("../modules/playerProgress/services/playerProgressService");

const XP_PER_LEVEL = 2500;

const TASK_DEFINITIONS = {
  daily: [
    {
      id: "daily_play_poker",
      title: "العب 5 جولات بوكر",
      subtitle: "اربح أو اخسر — المهم أن تكمل 5 جولات",
      metric: "poker_hands",
      target: 5,
      chipsReward: 500,
      xpReward: 150,
      icon: "cards",
    },
    {
      id: "daily_bonus",
      title: "احصل على مكافأة يومية",
      subtitle: "استلم مكافأة الحضور من الصفحة الرئيسية",
      metric: "daily_bonus",
      target: 1,
      chipsReward: 200,
      xpReward: 100,
      icon: "gift",
    },
    {
      id: "daily_win_streak",
      title: "فز 3 جولات متتالية",
      subtitle: "حقق سلسلة فوز 3 جولات بوكر على التوالي",
      metric: "win_streak",
      target: 3,
      chipsReward: 1000,
      xpReward: 250,
      icon: "trophy",
    },
    {
      id: "daily_earn_chips",
      title: "اكسب 10,000 رقاقة",
      subtitle: "اجمع أرباحك من الطاولات اليوم",
      metric: "chips_earned",
      target: 10000,
      chipsReward: 500,
      xpReward: 200,
      icon: "coins",
    },
  ],
  weekly: [
    {
      id: "weekly_play_poker",
      title: "العب 25 جولة بوكر",
      subtitle: "أكمل 25 جولة خلال الأسبوع",
      metric: "poker_hands",
      target: 25,
      chipsReward: 2000,
      xpReward: 500,
      icon: "cards",
    },
    {
      id: "weekly_win_poker",
      title: "فز 10 جولات بوكر",
      subtitle: "حقق 10 انتصارات خلال الأسبوع",
      metric: "poker_wins",
      target: 10,
      chipsReward: 3000,
      xpReward: 600,
      icon: "trophy",
    },
    {
      id: "weekly_trix_win",
      title: "فز بلعبة تركس",
      subtitle: "حقق انتصاراً في لعبة تركس كاملة",
      metric: "trix_wins",
      target: 1,
      chipsReward: 2000,
      xpReward: 400,
      icon: "casino",
    },
    {
      id: "weekly_earn_chips",
      title: "اكسب 50,000 رقاقة",
      subtitle: "اجمع أرباحك خلال الأسبوع",
      metric: "chips_earned",
      target: 50000,
      chipsReward: 2500,
      xpReward: 400,
      icon: "coins",
    },
  ],
  seasonal: [
    {
      id: "seasonal_play_poker",
      title: "العب 100 جولة بوكر",
      subtitle: "أكمل 100 جولة خلال الموسم",
      metric: "poker_hands",
      target: 100,
      chipsReward: 10000,
      xpReward: 2000,
      icon: "cards",
    },
    {
      id: "seasonal_win_poker",
      title: "فز 40 جولة بوكر",
      subtitle: "حقق 40 انتصاراً خلال الموسم",
      metric: "poker_wins",
      target: 40,
      chipsReward: 15000,
      xpReward: 2500,
      icon: "trophy",
    },
    {
      id: "seasonal_mini_games",
      title: "العب 10 ألعاب مصغرة",
      subtitle: "جرّب الألعاب المصغرة 10 مرات",
      metric: "mini_games",
      target: 10,
      chipsReward: 5000,
      xpReward: 800,
      icon: "dice",
    },
    {
      id: "seasonal_earn_chips",
      title: "اكسب 200,000 رقاقة",
      subtitle: "اجمع أرباحك خلال الموسم",
      metric: "chips_earned",
      target: 200000,
      chipsReward: 8000,
      xpReward: 1500,
      icon: "coins",
    },
  ],
};

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDayStr(d) {
  return d.toISOString().slice(0, 10);
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function seasonKey(d) {
  const month = d.getUTCMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${d.getUTCFullYear()}-Q${quarter}`;
}

function periodMeta(period, now = new Date()) {
  if (period === "weekly") {
    return { period, periodKey: isoWeekKey(now), since: new Date(now.getTime() - 7 * 86400000) };
  }
  if (period === "seasonal") {
    const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    const since = new Date(Date.UTC(now.getUTCFullYear(), qStartMonth, 1));
    return { period, periodKey: seasonKey(now), since };
  }
  const dayStart = startOfUtcDay(now);
  return { period: "daily", periodKey: utcDayStr(now), since: dayStart };
}

async function resolveMetric(userId, metric, since, user) {
  switch (metric) {
    case "poker_hands":
      return AnalyticsEvent.countDocuments({
        userId,
        name: "hand_played",
        createdAt: { $gte: since },
      });
    case "poker_wins":
      return AnalyticsEvent.countDocuments({
        userId,
        name: "hand_won",
        createdAt: { $gte: since },
      });
    case "trix_wins":
      return AnalyticsEvent.countDocuments({
        userId,
        name: "trix_game_won",
        createdAt: { $gte: since },
      });
    case "mini_games":
      return MiniGamePlay.countDocuments({ user: userId, createdAt: { $gte: since } });
    case "win_streak":
      return user?.pokerWinStreak || 0;
    case "daily_bonus": {
      const claimedToday =
        user?.lastDailyBonusAt &&
        startOfUtcDay(user.lastDailyBonusAt).getTime() === startOfUtcDay(new Date()).getTime();
      return claimedToday ? 1 : 0;
    }
    case "chips_earned": {
      const rows = await WalletTransaction.aggregate([
        {
          $match: {
            userId,
            type: "win",
            createdAt: { $gte: since },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);
      return rows[0]?.total || 0;
    }
    default:
      return 0;
  }
}

function mapTaskRow(def, current, claimed) {
  const target = def.target;
  const done = current >= target;
  return {
    id: def.id,
    title: def.title,
    subtitle: def.subtitle,
    metric: def.metric,
    currentProgress: Math.min(current, target),
    targetProgress: target,
    chipsReward: def.chipsReward,
    xpReward: def.xpReward,
    icon: def.icon,
    isCompleted: done,
    isClaimed: claimed,
    progress: Math.min(1, target > 0 ? current / target : 0),
  };
}

async function buildTasksForUser(userId, period) {
  const meta = periodMeta(period);
  const user = await User.findById(userId).select(
    "pokerWinStreak lastDailyBonusAt dailyBonusStreak name"
  );
  const defs = TASK_DEFINITIONS[period] || [];
  const claims = await UserTaskClaim.find({
    userId,
    period: meta.period,
    periodKey: meta.periodKey,
  }).lean();
  const claimedSet = new Set(claims.map((c) => c.taskId));

  const tasks = [];
  for (const def of defs) {
    const current = await resolveMetric(userId, def.metric, meta.since, user);
    tasks.push(mapTaskRow(def, current, claimedSet.has(def.id)));
  }

  const completed = tasks.filter((t) => t.isCompleted).length;
  const claimable = tasks.filter((t) => t.isCompleted && !t.isClaimed).length;

  return {
    period: meta.period,
    periodKey: meta.periodKey,
    tasks,
    completed,
    total: tasks.length,
    claimable,
    dailyBonusStreak: user?.dailyBonusStreak || 0,
  };
}

async function grantTaskRewards(userId, chips, xp, { taskId, periodKey } = {}) {
  if (chips > 0) {
    await withMongoTransaction(async (session) => {
      await ledgerDeposit({
        session,
        userId,
        amount: chips,
        meta: { source: "task_reward", taskId, periodKey },
        ledgerType: "confirmed_deposit",
      });
    });
  }

  if (xp > 0) {
    const sourceId =
      taskId && periodKey ? `${periodKey}:${taskId}` : `task:${Date.now()}`;
    await playerProgressService.grantXp(userId, xp, {
      source: "task",
      sourceId,
    });
  }
}

async function claimSingleTask(userId, taskId, period) {
  const meta = periodMeta(period);
  const def = (TASK_DEFINITIONS[period] || []).find((t) => t.id === taskId);
  if (!def) throw new ApiError("Task not found", 404);

  const existing = await UserTaskClaim.findOne({
    userId,
    taskId,
    period: meta.period,
    periodKey: meta.periodKey,
  }).lean();
  if (existing) throw new ApiError("Task reward already claimed", 400);

  const user = await User.findById(userId).select("pokerWinStreak lastDailyBonusAt");
  const current = await resolveMetric(userId, def.metric, meta.since, user);
  if (current < def.target) throw new ApiError("Task not completed yet", 400);

  await UserTaskClaim.create({
    userId,
    taskId,
    period: meta.period,
    periodKey: meta.periodKey,
    chipsGranted: def.chipsReward,
    xpGranted: def.xpReward,
  });

  await grantTaskRewards(userId, def.chipsReward, def.xpReward, {
    taskId,
    periodKey: meta.periodKey,
  });

  const { recordActivity } = require("./activityService");
  await recordActivity({
    userId,
    category: "task",
    label: `أكملت مهمة "${def.title}"`,
    subLabel: `المهام · ${meta.period === "daily" ? "يومية" : meta.period === "weekly" ? "أسبوعية" : "موسمية"}`,
    amountDisplay: `+${def.chipsReward.toLocaleString("en-US")}`,
    amountValue: def.chipsReward,
    icon: "star",
    sourceType: "task_claim",
    sourceId: `${meta.periodKey}:${taskId}`,
    meta: { taskId, period: meta.period, xp: def.xpReward },
  });

  const wallet = await Wallet.findOne({ user: userId }).lean();
  const player = await Player.findOne({ user: userId }).lean();

  return {
    taskId,
    chipsGranted: def.chipsReward,
    xpGranted: def.xpReward,
    balance: wallet?.balance || 0,
    level: player?.stats?.level || 1,
    experience: player?.stats?.experience || 0,
  };
}

exports.buildDailyTasksPreview = async (userId) => buildTasksForUser(userId, "daily");

exports.getTasks = asyncHandler(async (req, res) => {
  const period = (req.query.period || "daily").toLowerCase();
  if (!TASK_DEFINITIONS[period]) {
    return res.status(400).json({ status: "error", message: "Invalid period" });
  }

  const data = await buildTasksForUser(req.user._id, period);
  const player = await Player.findOne({ user: req.user._id }).lean();
  const wallet = await Wallet.findOne({ user: req.user._id }).lean();

  res.status(200).json({
    status: "success",
    data: {
      ...data,
      balance: wallet?.balance || 0,
      stats: {
        level: player?.stats?.level || 1,
        experience: player?.stats?.experience || 0,
        xpPerLevel: XP_PER_LEVEL,
        xpProgress: ((player?.stats?.experience || 0) % XP_PER_LEVEL) / XP_PER_LEVEL,
      },
    },
  });
});

exports.claimTask = asyncHandler(async (req, res, next) => {
  const period = (req.query.period || req.body?.period || "daily").toLowerCase();
  const taskId = req.params.taskId;
  if (!TASK_DEFINITIONS[period]) return next(new ApiError("Invalid period", 400));

  try {
    const result = await claimSingleTask(req.user._id, taskId, period);
    res.status(200).json({ status: "success", data: result });
  } catch (e) {
    if (e instanceof ApiError) return next(e);
    throw e;
  }
});

exports.claimAllTasks = asyncHandler(async (req, res, next) => {
  const period = (req.query.period || req.body?.period || "daily").toLowerCase();
  if (!TASK_DEFINITIONS[period]) return next(new ApiError("Invalid period", 400));

  const snapshot = await buildTasksForUser(req.user._id, period);
  const toClaim = snapshot.tasks.filter((t) => t.isCompleted && !t.isClaimed);
  if (!toClaim.length) {
    const wallet = await Wallet.findOne({ user: req.user._id }).lean();
    const player = await Player.findOne({ user: req.user._id }).lean();
    return res.status(200).json({
      status: "success",
      data: {
        claimed: [],
        totalChips: 0,
        totalXp: 0,
        balance: wallet?.balance || 0,
        level: player?.stats?.level || 1,
        experience: player?.stats?.experience || 0,
      },
    });
  }

  let totalChips = 0;
  let totalXp = 0;
  const claimed = [];

  for (const task of toClaim) {
    const result = await claimSingleTask(req.user._id, task.id, period);
    totalChips += result.chipsGranted;
    totalXp += result.xpGranted;
    claimed.push(result.taskId);
  }

  const wallet = await Wallet.findOne({ user: req.user._id }).lean();
  const player = await Player.findOne({ user: req.user._id }).lean();

  res.status(200).json({
    status: "success",
    data: {
      claimed,
      totalChips,
      totalXp,
      balance: wallet?.balance || 0,
      level: player?.stats?.level || 1,
      experience: player?.stats?.experience || 0,
    },
  });
});

exports.trackTrixWin = (userId, props = {}) => {
  const { trackEventServerFireAndForget } = require("./analyticsService");
  trackEventServerFireAndForget("trix_game_won", userId, props, "server");
};
