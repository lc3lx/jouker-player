const User = require("../models/userModel");
const UserDailyQuota = require("../models/userDailyQuotaModel");
const { sendAlert } = require("../utils/alert");
const { limits, isProduction } = require("../utils/appConfig");

function utcDayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function getOrCreateQuota(userId, dayUtc = utcDayString()) {
  let q = await UserDailyQuota.findOne({ userId, dayUtc });
  if (!q) {
    try {
      q = await UserDailyQuota.create({ userId, dayUtc });
    } catch (e) {
      if (e && e.code === 11000) {
        q = await UserDailyQuota.findOne({ userId, dayUtc });
      } else {
        throw e;
      }
    }
  }
  return q;
}

async function assertNotTrustRestricted(userId) {
  const u = await User.findById(userId).select("trustRestricted");
  if (u?.trustRestricted) {
    const err = new Error("TRUST_RESTRICTED");
    err.statusCode = 403;
    throw err;
  }
}

async function assertCanDeposit(userId, amount) {
  await assertNotTrustRestricted(userId);
  const L = limits();
  const q = await getOrCreateQuota(userId);
  if (q.depositTotal + amount > L.maxDepositPerDay) {
    const err = new Error("DEPOSIT_DAILY_LIMIT");
    err.statusCode = 400;
    throw err;
  }
}

async function assertCanWithdraw(userId, amount) {
  await assertNotTrustRestricted(userId);
  const L = limits();
  const q = await getOrCreateQuota(userId);
  if (q.withdrawTotal + amount > L.maxWithdrawPerDay) {
    const err = new Error("WITHDRAW_DAILY_LIMIT");
    err.statusCode = 400;
    throw err;
  }
}

async function recordDepositCompleted(userId, amount) {
  const dayUtc = utcDayString();
  await UserDailyQuota.findOneAndUpdate(
    { userId, dayUtc },
    { $inc: { depositTotal: amount } },
    { upsert: true }
  );
}

async function recordWithdrawCompleted(userId, amount) {
  const dayUtc = utcDayString();
  await UserDailyQuota.findOneAndUpdate(
    { userId, dayUtc },
    { $inc: { withdrawTotal: amount } },
    { upsert: true }
  );
}

async function assertCanClaimBonus(userId) {
  await assertNotTrustRestricted(userId);
  const L = limits();
  const q = await getOrCreateQuota(userId);
  if (q.bonusClaims >= L.maxBonusClaimsPerDay) {
    const err = new Error("BONUS_DAILY_LIMIT");
    err.statusCode = 400;
    throw err;
  }
}

async function recordBonusClaim(userId) {
  const dayUtc = utcDayString();
  await UserDailyQuota.findOneAndUpdate(
    { userId, dayUtc },
    { $inc: { bonusClaims: 1 } },
    { upsert: true }
  );
}

async function trackJoinLeaveEvent(userId, kind = "unknown") {
  const L = limits();
  const dayUtc = utcDayString();
  const q = await UserDailyQuota.findOneAndUpdate(
    { userId, dayUtc },
    { $inc: { joinLeaveEvents: 1 } },
    { upsert: true, new: true }
  );
  const n = q?.joinLeaveEvents ?? 0;
  if (n > L.joinLeaveMaxEvents) {
    void sendAlert("join_leave_flood", {
      userId: String(userId),
      kind,
      count: n,
      dayUtc,
      limit: L.joinLeaveMaxEvents,
    });
    if (isProduction()) {
      await User.updateOne(
        { _id: userId },
        { $set: { suspiciousFlag: true } }
      );
    }
  }
}

/**
 * Heads-up style chip flow: large one-way net between two humans on one hand.
 */
async function evaluateHandChipDumpSuspect({ tableId, seatSummaries }) {
  if (!Array.isArray(seatSummaries) || seatSummaries.length < 2) return;
  const humans = seatSummaries.filter(
    (s) =>
      s &&
      !s.isBot &&
      s.userId &&
      typeof s.userId !== "undefined" &&
      !String(s.userId).startsWith("bot:")
  );
  if (humans.length !== 2) return;
  const threshold = Math.max(
    1000,
    parseInt(process.env.CHIP_DUMP_NET_THRESHOLD || "250000", 10)
  );
  const [a, b] = humans;
  const netA = Number(a.net) || 0;
  const netB = Number(b.net) || 0;
  if (netA <= -threshold && netB >= threshold) {
    void sendAlert("chip_dump_suspect", {
      tableId: String(tableId),
      fromUserId: String(a.userId),
      toUserId: String(b.userId),
      netFrom: netA,
      netTo: netB,
    });
    if (isProduction()) {
      await User.updateMany(
        { _id: { $in: [a.userId, b.userId] } },
        { $set: { suspiciousFlag: true } }
      );
    }
  } else if (netB <= -threshold && netA >= threshold) {
    void sendAlert("chip_dump_suspect", {
      tableId: String(tableId),
      fromUserId: String(b.userId),
      toUserId: String(a.userId),
      netFrom: netB,
      netTo: netA,
    });
    if (isProduction()) {
      await User.updateMany(
        { _id: { $in: [a.userId, b.userId] } },
        { $set: { suspiciousFlag: true } }
      );
    }
  }
}

module.exports = {
  utcDayString,
  assertNotTrustRestricted,
  assertCanDeposit,
  assertCanWithdraw,
  recordDepositCompleted,
  recordWithdrawCompleted,
  assertCanClaimBonus,
  recordBonusClaim,
  trackJoinLeaveEvent,
  evaluateHandChipDumpSuspect,
};
