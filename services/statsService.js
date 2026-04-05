const asyncHandler = require("express-async-handler");
const Player = require("../models/playerModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const ApiError = require("../utils/apiError");
const { dailyBonusBaseChips, limits, appMode } = require("../utils/appConfig");
const { assertCanClaimBonus, recordBonusClaim } = require("./fraudService");
const { trackEventServerFireAndForget } = require("./analyticsService");
const { withMongoTransaction, ledgerDeposit } = require("./walletLedgerService");

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDayStr(d) {
  return d.toISOString().slice(0, 10);
}

function yesterdayUtcStrFrom(now) {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
  return new Date(t).toISOString().slice(0, 10);
}

exports.getMyStats = asyncHandler(async (req, res) => {
  const player = await Player.getOrCreateByUser(req.user._id);
  const s = player.stats || {};
  const gamesPlayed = s.gamesPlayed || 0;
  const wins = s.wins || 0;
  const winRate = gamesPlayed > 0 ? wins / gamesPlayed : 0;
  res.status(200).json({
    status: "success",
    data: {
      wins,
      gamesPlayed,
      winRate,
      bestScore: s.bestScore || 0,
      totalScore: s.totalScore || 0,
      totalPlayTimeSec: s.totalPlayTimeSec || 0,
      level: s.level || 1,
      experience: s.experience || 0,
    },
  });
});

exports.getCountryRanking = asyncHandler(async (req, res) => {
  // Determine target country
  let country = (req.query.country || "").toUpperCase();
  if (!country) {
    const user = await User.findById(req.user._id);
    country = (user?.country || "").toUpperCase();
  }

  const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);

  const pipeline = [
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
  ];

  if (country) {
    pipeline.push({ $match: { "user.country": country } });
  }

  pipeline.push(
    {
      $project: {
        displayName: 1,
        stats: 1,
        user: {
          _id: "$user._id",
          name: "$user.name",
          country: "$user.country",
        },
      },
    },
    { $sort: { "stats.wins": -1, "stats.bestScore": -1 } },
    { $limit: limit }
  );

  const rows = await Player.aggregate(pipeline);

  // Compute current user rank (if present in the same country)
  const meIndex = rows.findIndex((r) => String(r.user._id) === String(req.user._id));
  const myRank = meIndex >= 0 ? meIndex + 1 : null;

  res.status(200).json({
    status: "success",
    data: {
      country: country || null,
      myRank,
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.user._id,
        name: r.user.name,
        country: r.user.country,
        displayName: r.displayName,
        wins: r.stats?.wins || 0,
        bestScore: r.stats?.bestScore || 0,
      })),
    },
  });
});

exports.getBalanceLeaderboard = asyncHandler(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
  const rows = await Wallet.find()
    .populate("user", "name profileImg")
    .sort({ balance: -1 })
    .limit(limit)
    .lean();

  res.status(200).json({
    status: "success",
    data: rows.map((w, i) => ({
      rank: i + 1,
      userId: w.user?._id,
      name: (w.user && w.user.name) || "Player",
      balance: w.balance || 0,
    })),
  });
});

exports.claimDailyBonus = asyncHandler(async (req, res, next) => {
  const base = dailyBonusBaseChips();
  if (base <= 0) {
    return next(new ApiError("Daily bonus is disabled", 400));
  }

  const userId = req.user._id;
  const now = new Date();
  const L = limits();

  try {
    await assertCanClaimBonus(userId);
  } catch (e) {
    if (e.message === "TRUST_RESTRICTED") {
      return next(new ApiError("Account restricted — contact support", 403));
    }
    if (e.message === "BONUS_DAILY_LIMIT") {
      return next(new ApiError("Daily bonus claim limit reached", 400));
    }
    throw e;
  }

  const user = await User.findById(userId).select(
    "lastDailyBonusAt lastDailyBonusDayUtc dailyBonusStreak pokerWinStreak trustRestricted"
  );
  if (!user) return next(new ApiError("User not found", 404));
  if (user.trustRestricted) {
    return next(new ApiError("Account restricted — contact support", 403));
  }

  if (L.maxBonusClaimsPerDay <= 1) {
    if (
      user.lastDailyBonusAt &&
      startOfUtcDay(user.lastDailyBonusAt).getTime() === startOfUtcDay(now).getTime()
    ) {
      return next(new ApiError("Daily bonus already claimed", 400));
    }
  }

  const todayStr = utcDayStr(now);
  let nextStreak;
  const lastDay = user.lastDailyBonusDayUtc;
  if (lastDay === todayStr) {
    nextStreak = user.dailyBonusStreak || 1;
  } else if (lastDay === yesterdayUtcStrFrom(now)) {
    nextStreak = (user.dailyBonusStreak || 0) + 1;
  } else {
    nextStreak = 1;
  }

  const winMult = 1 + Math.min(0.02 * Math.min(user.pokerWinStreak || 0, 50), 0.2);
  const grant = Math.floor(base * winMult);

  await withMongoTransaction(async (session) => {
    await ledgerDeposit({
      session,
      userId,
      amount: grant,
      meta: {
        source: "daily_bonus",
        dailyBonusStreak: nextStreak,
        winStreakMultiplier: winMult,
        baseChips: base,
      },
      ledgerType: "confirmed_deposit",
    });
    await User.findByIdAndUpdate(
      userId,
      {
        lastDailyBonusAt: now,
        lastDailyBonusDayUtc: todayStr,
        dailyBonusStreak: nextStreak,
      },
      { session }
    );
  });

  await recordBonusClaim(userId);
  trackEventServerFireAndForget(
    "claim_bonus",
    userId,
    { granted: grant, streak: nextStreak, winMult },
    "server"
  );

  const wallet = await Wallet.findOne({ user: userId });
  res.status(200).json({
    status: "success",
    data: {
      granted: grant,
      baseChips: base,
      dailyBonusStreak: nextStreak,
      winStreakMultiplier: winMult,
      balance: wallet?.balance ?? 0,
      lockedBalance: wallet?.lockedBalance ?? 0,
    },
  });
});

exports.getPokerRetention = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    "pokerHandsPlayed pokerHandsWon lastDailyBonusAt dailyBonusStreak pokerWinStreak"
  );
  if (!user) {
    return res.status(404).json({ status: "error", message: "User not found" });
  }
  const now = new Date();
  const claimedToday =
    user.lastDailyBonusAt &&
    startOfUtcDay(user.lastDailyBonusAt).getTime() === startOfUtcDay(now).getTime();
  const winMultPreview = 1 + Math.min(0.02 * Math.min(user.pokerWinStreak || 0, 50), 0.2);
  res.status(200).json({
    status: "success",
    data: {
      pokerHandsPlayed: user.pokerHandsPlayed || 0,
      pokerHandsWon: user.pokerHandsWon || 0,
      dailyBonusClaimedToday: !!claimedToday,
      dailyBonusStreak: user.dailyBonusStreak || 0,
      pokerWinStreak: user.pokerWinStreak || 0,
      nextDailyBonusMultiplierPreview: winMultPreview,
      appMode: appMode(),
    },
  });
});

/** Rolling 7-day poker win volume (wallet `win` ledger rows). */
exports.getWeeklyPokerWinsLeaderboard = asyncHandler(async (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await WalletTransaction.aggregate([
    { $match: { type: "win", createdAt: { $gte: since } } },
    { $group: { _id: "$userId", totalWon: { $sum: "$amount" } } },
    { $sort: { totalWon: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "u",
      },
    },
    { $unwind: "$u" },
    { $project: { userId: "$_id", name: "$u.name", totalWon: 1 } },
  ]);

  res.status(200).json({
    status: "success",
    data: {
      periodDays: 7,
      since: since.toISOString(),
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        name: r.name || "Player",
        totalWon: r.totalWon || 0,
      })),
    },
  });
});
