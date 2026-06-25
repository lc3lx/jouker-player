const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const LuckyWheel = require("../models/luckyWheelModel");
const LuckyWheelSpinHistory = require("../models/luckyWheelSpinHistoryModel");
const User = require("../models/userModel");
const Wallet = require("../models/walletModel");
const ApiError = require("../utils/apiError");
const { withMongoTransaction, ledgerDeposit } = require("./walletLedgerService");
const { recordActivity } = require("./activityService");
const { trackEventServerFireAndForget } = require("./analyticsService");

const SPIN_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const STREAK_BASE_TOKENS = 5000;
const STREAK_MAX_GUARANTEE = 100000;
const MAX_BANKED_SPINS = 5;

const REWARD_WEIGHTS = [0.5, 0.25, 0.15, 0.07, 0.025, 0.005];
const TIER_NAMES = ["minimum", "next", "mid", "high", "rare", "jackpot"];

const TIER_MULTIPLIERS_LOW = [1, 1.5, 2, 3, 4, 5];
const TIER_MULTIPLIERS_MID = [1, 1.2, 1.5, 2, 3, 4];
const TIER_MULTIPLIERS_HIGH = [1, 1.25, 1.5, 2, 3, 5];

/** Visual wheel segments — display only; rewards are server-generated. */
const WHEEL_DISPLAY_SEGMENTS = [
  5000, 10000, 15000, 20000, 25000, 50000, 75000, 100000, 150000, 200000, 500000,
];

function utcDayStr(d) {
  return d.toISOString().slice(0, 10);
}

function yesterdayUtcStrFrom(now) {
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1);
  return new Date(t).toISOString().slice(0, 10);
}

function guaranteedMinimumForStreak(streakDay) {
  const day = Math.max(1, Math.floor(streakDay || 1));
  return Math.min(day * STREAK_BASE_TOKENS, STREAK_MAX_GUARANTEE);
}

function tierMultipliersForStreak(streakDay) {
  if (streakDay >= 20) return TIER_MULTIPLIERS_HIGH;
  if (streakDay >= 10) return TIER_MULTIPLIERS_MID;
  return TIER_MULTIPLIERS_LOW;
}

function buildRewardTable(guaranteedMin, streakDay) {
  const multipliers = tierMultipliersForStreak(streakDay);
  return multipliers.map((m) => Math.round(guaranteedMin * m));
}

function previewNextStreak(wheel, now) {
  const todayStr = utcDayStr(now);
  const lastDay = wheel.lastSpinDayUtc;
  const current = wheel.currentStreak || 0;

  if (!lastDay) return 1;
  if (lastDay === todayStr) return Math.max(1, current);
  if (lastDay === yesterdayUtcStrFrom(now)) return Math.max(1, current + 1);
  return 1;
}

function resolveStreakOnSpin(wheel, now) {
  const todayStr = utcDayStr(now);
  const lastDay = wheel.lastSpinDayUtc;
  const current = wheel.currentStreak || 0;

  if (!lastDay) return 1;
  if (lastDay === todayStr) return Math.max(1, current);
  if (lastDay === yesterdayUtcStrFrom(now)) return Math.max(1, current + 1);
  return 1;
}

function syncAccruedSpins(wheel, now) {
  if (!wheel.lastAccrualAt) {
    wheel.lastAccrualAt = now;
    wheel.availableSpins = Math.max(1, wheel.availableSpins || 0);
    wheel.nextSpinAt = new Date(now.getTime() + SPIN_COOLDOWN_MS);
    return;
  }

  const elapsed = now.getTime() - new Date(wheel.lastAccrualAt).getTime();
  if (elapsed < SPIN_COOLDOWN_MS) {
    wheel.nextSpinAt = new Date(new Date(wheel.lastAccrualAt).getTime() + SPIN_COOLDOWN_MS);
    return;
  }

  const accrued = Math.floor(elapsed / SPIN_COOLDOWN_MS);
  if (accrued <= 0) return;

  const room = Math.max(0, MAX_BANKED_SPINS - (wheel.availableSpins || 0));
  const toGrant = Math.min(accrued, room);
  if (toGrant > 0) {
    wheel.availableSpins = (wheel.availableSpins || 0) + toGrant;
    wheel.lastAccrualAt = new Date(
      new Date(wheel.lastAccrualAt).getTime() + toGrant * SPIN_COOLDOWN_MS
    );
  }
  wheel.nextSpinAt = new Date(new Date(wheel.lastAccrualAt).getTime() + SPIN_COOLDOWN_MS);
}

function remainingSecondsUntilNextSpin(wheel, now) {
  if ((wheel.availableSpins || 0) > 0) return 0;
  if (!wheel.nextSpinAt) return 0;
  const diff = new Date(wheel.nextSpinAt).getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / 1000));
}

function pickWeightedReward(rewards) {
  const roll = crypto.randomInt(0, 1_000_000) / 1_000_000;
  let cumulative = 0;
  for (let i = 0; i < REWARD_WEIGHTS.length; i++) {
    cumulative += REWARD_WEIGHTS[i];
    if (roll < cumulative) {
      return { reward: rewards[i], rewardTier: TIER_NAMES[i], tierIndex: i };
    }
  }
  return {
    reward: rewards[rewards.length - 1],
    rewardTier: TIER_NAMES[rewards.length - 1],
    tierIndex: rewards.length - 1,
  };
}

function nearestWheelSegment(reward) {
  let best = WHEEL_DISPLAY_SEGMENTS[0];
  let bestDiff = Math.abs(reward - best);
  for (const seg of WHEEL_DISPLAY_SEGMENTS) {
    const diff = Math.abs(reward - seg);
    if (diff < bestDiff) {
      best = seg;
      bestDiff = diff;
    }
  }
  return best;
}

async function loadAndSyncWheel(userId, session) {
  const wheel = await LuckyWheel.getOrCreateByUser(userId, session);
  const now = new Date();
  syncAccruedSpins(wheel, now);
  return { wheel, now };
}

exports.getLuckyWheelStatus = asyncHandler(async (req, res, next) => {
  const userId = req.user._id;
  const user = await User.findById(userId).select("trustRestricted");
  if (!user) return next(new ApiError("User not found", 404));
  if (user.trustRestricted) {
    return next(new ApiError("Account restricted — contact support", 403));
  }

  const { wheel, now } = await loadAndSyncWheel(userId);
  await wheel.save();

  const previewStreak = previewNextStreak(wheel, now);
  const guaranteedReward = guaranteedMinimumForStreak(previewStreak);
  const canSpin = (wheel.availableSpins || 0) > 0;

  res.status(200).json({
    status: "success",
    data: {
      canSpin,
      availableSpins: wheel.availableSpins || 0,
      currentStreak: Math.max(0, wheel.currentStreak || 0),
      previewStreak,
      guaranteedReward,
      nextSpinAt: wheel.nextSpinAt ? wheel.nextSpinAt.toISOString() : null,
      remainingSeconds: remainingSecondsUntilNextSpin(wheel, now),
      wheelSegments: WHEEL_DISPLAY_SEGMENTS,
      lifetimeSpins: wheel.lifetimeSpins || 0,
      lifetimeTokensWon: wheel.lifetimeTokensWon || 0,
      highestRewardWon: wheel.highestRewardWon || 0,
      serverTime: now.toISOString(),
    },
  });
});

exports.spinLuckyWheel = asyncHandler(async (req, res, next) => {
  const userId = req.user._id;
  const user = await User.findById(userId).select("trustRestricted");
  if (!user) return next(new ApiError("User not found", 404));
  if (user.trustRestricted) {
    return next(new ApiError("Account restricted — contact support", 403));
  }

  let spinResult;

  await withMongoTransaction(async (session) => {
    const { wheel, now } = await loadAndSyncWheel(userId, session);

    if ((wheel.availableSpins || 0) <= 0) {
      const remaining = remainingSecondsUntilNextSpin(wheel, now);
      throw new ApiError(
        `No spins available. Next spin in ${remaining} seconds.`,
        400
      );
    }

    const nextStreak = resolveStreakOnSpin(wheel, now);
    const guaranteedMin = guaranteedMinimumForStreak(nextStreak);
    const rewardTable = buildRewardTable(guaranteedMin, nextStreak);
    const { reward, rewardTier } = pickWeightedReward(rewardTable);
    const wheelSegment = nearestWheelSegment(reward);

    wheel.availableSpins = Math.max(0, (wheel.availableSpins || 0) - 1);
    wheel.lastClaimAt = now;
    wheel.lastSpinDayUtc = utcDayStr(now);
    wheel.currentStreak = nextStreak;
    wheel.lifetimeSpins = (wheel.lifetimeSpins || 0) + 1;
    wheel.lifetimeTokensWon = (wheel.lifetimeTokensWon || 0) + reward;
    if (reward > (wheel.highestRewardWon || 0)) {
      wheel.highestRewardWon = reward;
    }
    syncAccruedSpins(wheel, now);
    await wheel.save({ session });

    const [history] = await LuckyWheelSpinHistory.create(
      [
        {
          userId,
          reward,
          rewardTier,
          guaranteedMinimum: guaranteedMin,
          currentStreak: nextStreak,
          spunAt: now,
        },
      ],
      { session }
    );

    await ledgerDeposit({
      session,
      userId,
      amount: reward,
      meta: {
        source: "lucky_wheel",
        rewardTier,
        guaranteedMinimum: guaranteedMin,
        currentStreak: nextStreak,
        spinHistoryId: String(history._id),
        wheelSegment,
      },
      ledgerType: "confirmed_deposit",
    });

    spinResult = {
      reward,
      rewardTier,
      wheelSegment,
      currentStreak: nextStreak,
      guaranteedMinimum: guaranteedMin,
      nextSpinAt: wheel.nextSpinAt ? wheel.nextSpinAt.toISOString() : null,
      availableSpins: wheel.availableSpins || 0,
      remainingSeconds: remainingSecondsUntilNextSpin(wheel, now),
      spinId: String(history._id),
    };
  });

  const wallet = await Wallet.findOne({ user: userId });
  spinResult.balance = wallet?.balance ?? 0;

  trackEventServerFireAndForget(
    "lucky_wheel_spin",
    userId,
    {
      reward: spinResult.reward,
      rewardTier: spinResult.rewardTier,
      streak: spinResult.currentStreak,
    },
    "server"
  );

  recordActivity({
    userId,
    sourceType: "lucky_wheel",
    sourceId: spinResult.spinId,
    category: "bonus",
    title: "عجلة الحظ",
    body: `ربحت ${spinResult.reward.toLocaleString("en-US")} عملة من عجلة الحظ`,
    amount: spinResult.reward,
    meta: {
      rewardTier: spinResult.rewardTier,
      currentStreak: spinResult.currentStreak,
    },
  }).catch(() => {});

  res.status(200).json({
    status: "success",
    data: spinResult,
  });
});

exports.getLuckyWheelHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const limit = Math.min(50, parseInt(req.query.limit || "20", 10));
  const rows = await LuckyWheelSpinHistory.find({ userId })
    .sort({ spunAt: -1 })
    .limit(limit)
    .lean();

  res.status(200).json({
    status: "success",
    data: {
      history: rows.map((r) => ({
        id: String(r._id),
        reward: r.reward,
        rewardTier: r.rewardTier,
        guaranteedMinimum: r.guaranteedMinimum,
        currentStreak: r.currentStreak,
        spunAt: r.spunAt,
      })),
    },
  });
});

exports.WHEEL_DISPLAY_SEGMENTS = WHEEL_DISPLAY_SEGMENTS;
