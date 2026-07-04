"use strict";

/**
 * VIP membership service — server-authoritative core for the VIP system.
 *
 * Responsibilities:
 *   - membership state (purchase / upgrade / downgrade / renewal / expiration
 *     / cancel / restore / admin grant) with an append-only VIPHistory trail
 *   - daily VIP chips (separate from the normal daily bonus, duplicate-safe)
 *   - weekly loss cashback (Monday→Monday UTC, losses only, capped, claim-once)
 *   - daily Gold/Platinum quiz (server-picked question, one attempt per day)
 *   - cached level resolution for game seats / chat / matchmaking priority
 *
 * All wallet credits go through walletLedgerService inside withMongoTransaction
 * and every claim is guarded by a unique index, so retries and races can never
 * double-pay (duplicate key → ALREADY_CLAIMED).
 */

const mongoose = require("mongoose");
const asyncHandler = require("express-async-handler");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const vipLevelCache = require("../utils/vipLevelCache");
const VIPSubscription = require("../models/vipSubscriptionModel");
const VIPHistory = require("../models/vipHistoryModel");
const DailyVIPClaim = require("../models/vipDailyClaimModel");
const WeeklyCashback = require("../models/vipWeeklyCashbackModel");
const VIPQuizQuestion = require("../models/vipQuizQuestionModel");
const VIPQuizAttempt = require("../models/vipQuizAttemptModel");
const User = require("../models/userModel");
const WalletTransaction = require("../models/walletTransactionModel");
const { withMongoTransaction, ledgerDeposit } = require("./walletLedgerService");
const {
  VIP_LEVELS,
  VIP_LEVEL_CONFIG,
  SUBSCRIPTION_DAYS,
  CASHBACK_LOSS_TX_TYPES,
  normalizeVipLevel,
  vipLevelRank,
  vipLevelConfig,
  computeCashbackAmount,
  utcDayStr,
  previousWeekRangeUtc,
  dailyQuestionIndex,
  publicBenefits,
} = require("../config/vipConfig");

const USER_PROVIDERS = ["google_play", "apple", "stripe"];

function toIdStr(v) {
  return String(v?._id || v || "");
}

function isDuplicateKeyError(e) {
  return e && (e.code === 11000 || e.code === 11001);
}

// ─── Level resolution + cache ───────────────────────────────────────────────

/** Active level from a subscription doc (active/cancelled + not expired). */
function levelFromSubscription(sub, now = new Date()) {
  if (!sub) return null;
  if (sub.status === "expired") return null;
  if (!sub.expireDate || new Date(sub.expireDate) <= now) return null;
  return normalizeVipLevel(sub.currentLevel);
}

async function getSubscription(userId) {
  return VIPSubscription.findOne({ userId });
}

/** Cached single-user level ("bronze"… or null). */
async function getVipLevel(userId) {
  const uid = toIdStr(userId);
  if (!uid) return null;
  const cached = await vipLevelCache.get(uid);
  if (cached) return cached.level;

  const sub = await VIPSubscription.findOne({ userId: uid }).lean();
  const level = levelFromSubscription(sub);
  await vipLevelCache.set(uid, level);
  return level;
}

/** Bulk cached resolution: Map<userIdStr, level|null>. */
async function getVipLevelsForUsers(userIds) {
  const ids = [...new Set((userIds || []).map(toIdStr).filter(Boolean))];
  const out = new Map();
  if (ids.length === 0) return out;

  const missing = [];
  for (const uid of ids) {
    const cached = await vipLevelCache.get(uid);
    if (cached) out.set(uid, cached.level);
    else missing.push(uid);
  }
  if (missing.length === 0) return out;

  const rows = await VIPSubscription.find({ userId: { $in: missing } }).lean();
  const byUser = new Map(rows.map((r) => [String(r.userId), r]));
  for (const uid of missing) {
    const level = levelFromSubscription(byUser.get(uid) || null);
    await vipLevelCache.set(uid, level);
    out.set(uid, level);
  }
  return out;
}

/**
 * Synchronous cache peek for hot paths (game state building). Returns the
 * level string or null; never blocks. Cache misses warm asynchronously so
 * the next state broadcast picks the level up.
 */
function peekVipLevelSync(userId) {
  const uid = toIdStr(userId);
  if (!uid || uid.startsWith("bot")) return null;
  const peeked = vipLevelCache.peekSync(uid);
  if (peeked === undefined) {
    void getVipLevel(uid).catch(() => {});
    return null;
  }
  return peeked;
}

async function invalidateVipCache(userId) {
  await vipLevelCache.del(toIdStr(userId));
}

/** Attach `vipLevel` to poker snapshot public-state seats (recovery path). */
async function mergeVipIntoPublicState(state) {
  if (!state || !Array.isArray(state.seats)) return state;
  const ids = state.seats.map((s) => s.userId).filter(Boolean);
  const map = await getVipLevelsForUsers(ids);
  for (const s of state.seats) {
    s.vipLevel = map.get(String(s.userId)) || null;
  }
  return state;
}

// ─── Membership state changes ───────────────────────────────────────────────

/** Keep legacy `user.vip {active, expiresAt}` in sync (vipTableService uses it). */
async function syncUserVipFlag(userId, sub, session) {
  const active = !!levelFromSubscription(sub);
  await User.findByIdAndUpdate(
    userId,
    {
      $set: {
        "vip.active": active,
        "vip.expiresAt": sub?.expireDate || null,
      },
    },
    session ? { session } : {}
  );
}

async function recordHistory(entry, session) {
  await VIPHistory.create([entry], session ? { session } : {});
}

async function afterMembershipChanged(userId) {
  await invalidateVipCache(userId);
  try {
    const { refreshVipForUserOnTables } = require("../sockets/tableGame");
    await refreshVipForUserOnTables(userId);
  } catch (e) {
    logger.warn("vip_refresh_tables_failed", { reason: e?.message || "unknown" });
  }
}

/**
 * Apply a membership change atomically and append history.
 *
 * kind:
 *   purchase | renewal | upgrade | downgrade — store/user flows
 *   admin_gift | admin_extend | admin_change_level | admin_remove — admin flows
 *   restore — provider restore
 */
async function applyMembershipChange({
  userId,
  level = null,
  provider = "admin",
  providerRef = null,
  actorId = null,
  days = SUBSCRIPTION_DAYS,
  kind,
  note = null,
  priceCents = 0,
}) {
  const uid = toIdStr(userId);
  const now = new Date();
  let resultSub = null;
  let action = kind;

  await withMongoTransaction(async (session) => {
    const query = VIPSubscription.findOne({ userId: uid });
    if (session) query.session(session);
    const sub = await query;
    const activeLevel = levelFromSubscription(sub, now);

    if (kind === "admin_remove") {
      if (!sub) throw new ApiError("User has no VIP subscription", 404);
      sub.status = "expired";
      sub.expireDate = now;
      sub.autoRenew = false;
      await sub.save(session ? { session } : {});
      await recordHistory(
        {
          userId: uid,
          action: "admin_remove",
          level: null,
          previousLevel: activeLevel,
          provider: "admin",
          actorId,
          note,
        },
        session
      );
      await syncUserVipFlag(uid, sub, session);
      resultSub = sub;
      return;
    }

    const newLevel = normalizeVipLevel(level);
    if (!newLevel) throw new ApiError("Invalid VIP level", 400);
    const grantDays = Math.max(1, Math.min(365, Math.floor(Number(days) || SUBSCRIPTION_DAYS)));
    const grantMs = grantDays * 24 * 60 * 60 * 1000;

    // Resolve the concrete action + new expiry.
    let expireDate;
    if (!activeLevel) {
      action = kind.startsWith("admin_") ? "admin_gift" : kind === "restore" ? "restore" : "purchase";
      expireDate = new Date(now.getTime() + grantMs);
    } else if (kind === "admin_extend") {
      action = "admin_extend";
      expireDate = new Date(new Date(sub.expireDate).getTime() + grantMs);
    } else if (newLevel === activeLevel) {
      action = kind.startsWith("admin_") ? "admin_extend" : "renewal";
      expireDate = new Date(new Date(sub.expireDate).getTime() + grantMs);
    } else {
      const up = vipLevelRank(newLevel) > vipLevelRank(activeLevel);
      action = kind.startsWith("admin_")
        ? "admin_change_level"
        : up
          ? "upgrade"
          : "downgrade";
      // Level changes take effect immediately with a fresh period.
      expireDate = new Date(now.getTime() + grantMs);
    }

    const previousLevel = activeLevel;
    if (sub) {
      sub.currentLevel = kind === "admin_extend" ? sub.currentLevel : newLevel;
      sub.startDate = activeLevel ? sub.startDate : now;
      sub.expireDate = expireDate;
      sub.status = "active";
      sub.autoRenew = kind.startsWith("admin_") ? sub.autoRenew : true;
      sub.purchaseProvider = kind.startsWith("admin_") ? "admin" : provider;
      if (providerRef) sub.providerRef = providerRef;
      await sub.save(session ? { session } : {});
      resultSub = sub;
    } else {
      const created = await VIPSubscription.create(
        [
          {
            userId: uid,
            currentLevel: newLevel,
            startDate: now,
            expireDate,
            autoRenew: !kind.startsWith("admin_"),
            purchaseProvider: kind.startsWith("admin_") ? "admin" : provider,
            status: "active",
            providerRef: providerRef || undefined,
          },
        ],
        session ? { session } : {}
      );
      resultSub = created[0];
    }

    await recordHistory(
      {
        userId: uid,
        action,
        level: kind === "admin_extend" ? resultSub.currentLevel : newLevel,
        previousLevel,
        provider: kind.startsWith("admin_") ? "admin" : provider,
        priceCents,
        expireDate,
        providerRef,
        actorId,
        note,
      },
      session
    );
    await syncUserVipFlag(uid, resultSub, session);
  });

  await afterMembershipChanged(uid);
  return { subscription: resultSub, action };
}

// ─── Receipt validation (server authoritative) ──────────────────────────────

function iapAllowUnverified() {
  return String(process.env.VIP_IAP_ALLOW_UNVERIFIED || "").toLowerCase() === "true";
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return null;
  try {
    return require("stripe")(key);
  } catch (_) {
    return null;
  }
}

/**
 * Validate a purchase receipt. Returns { ok, providerRef, reason? }.
 *  - stripe:      retrieves the PaymentIntent and checks succeeded + amount.
 *  - apple:       verifyReceipt endpoint when APPLE_SHARED_SECRET is set.
 *  - google_play: env-configured verifier endpoint (service-account proxy).
 * Dev/staging can set VIP_IAP_ALLOW_UNVERIFIED=true to accept raw tokens.
 */
async function validateReceipt({ provider, receipt, level, userId }) {
  const cfg = vipLevelConfig(level);
  if (!cfg) return { ok: false, reason: "invalid_level" };

  if (provider === "stripe") {
    const paymentIntentId = String(receipt?.paymentIntentId || receipt?.providerRef || "").trim();
    if (!paymentIntentId) return { ok: false, reason: "missing_payment_intent" };
    const stripe = getStripe();
    if (!stripe) {
      if (iapAllowUnverified()) return { ok: true, providerRef: paymentIntentId };
      return { ok: false, reason: "stripe_not_configured" };
    }
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (!pi || pi.status !== "succeeded") return { ok: false, reason: "payment_not_succeeded" };
      if (Number(pi.amount_received || pi.amount || 0) < cfg.priceCents) {
        return { ok: false, reason: "amount_mismatch" };
      }
      const metaUser = pi.metadata && pi.metadata.user_id ? String(pi.metadata.user_id) : null;
      if (metaUser && metaUser !== String(userId)) return { ok: false, reason: "user_mismatch" };
      return { ok: true, providerRef: pi.id };
    } catch (e) {
      logger.warn("vip_stripe_receipt_failed", { reason: e?.message || "unknown" });
      return { ok: false, reason: "stripe_verify_failed" };
    }
  }

  if (provider === "apple") {
    const receiptData = String(receipt?.receiptData || receipt?.purchaseToken || "").trim();
    if (!receiptData) return { ok: false, reason: "missing_receipt" };
    const secret = process.env.APPLE_SHARED_SECRET || "";
    if (!secret || typeof fetch !== "function") {
      if (iapAllowUnverified()) return { ok: true, providerRef: receiptData.slice(0, 128) };
      return { ok: false, reason: "apple_not_configured" };
    }
    try {
      const verify = async (url) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ "receipt-data": receiptData, password: secret }),
        });
        return res.json();
      };
      let data = await verify("https://buy.itunes.apple.com/verifyReceipt");
      if (data && data.status === 21007) {
        data = await verify("https://sandbox.itunes.apple.com/verifyReceipt");
      }
      if (!data || data.status !== 0) return { ok: false, reason: `apple_status_${data?.status}` };
      const latest = Array.isArray(data.latest_receipt_info) ? data.latest_receipt_info[0] : null;
      const txId = latest?.original_transaction_id || latest?.transaction_id;
      return { ok: true, providerRef: String(txId || receiptData.slice(0, 128)) };
    } catch (e) {
      logger.warn("vip_apple_receipt_failed", { reason: e?.message || "unknown" });
      return { ok: false, reason: "apple_verify_failed" };
    }
  }

  if (provider === "google_play") {
    const purchaseToken = String(receipt?.purchaseToken || "").trim();
    if (!purchaseToken) return { ok: false, reason: "missing_purchase_token" };
    const verifierUrl = process.env.GOOGLE_PLAY_VERIFIER_URL || "";
    if (!verifierUrl || typeof fetch !== "function") {
      if (iapAllowUnverified()) return { ok: true, providerRef: purchaseToken.slice(0, 128) };
      return { ok: false, reason: "google_play_not_configured" };
    }
    try {
      const res = await fetch(verifierUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchaseToken,
          productId: receipt?.productId || `vip_${level}`,
          packageName: receipt?.packageName || process.env.ANDROID_PACKAGE_NAME || "",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data || data.valid !== true) return { ok: false, reason: "google_play_invalid" };
      return { ok: true, providerRef: String(data.orderId || purchaseToken.slice(0, 128)) };
    } catch (e) {
      logger.warn("vip_google_receipt_failed", { reason: e?.message || "unknown" });
      return { ok: false, reason: "google_play_verify_failed" };
    }
  }

  return { ok: false, reason: "unsupported_provider" };
}

/** Fake/duplicate purchase guard: providerRef may credit membership only once. */
async function assertProviderRefUnused(providerRef) {
  if (!providerRef) return;
  const dup = await VIPHistory.findOne({
    providerRef,
    action: { $in: ["purchase", "upgrade", "downgrade", "renewal"] },
  }).lean();
  if (dup) throw new ApiError("This purchase was already processed", 409);
}

// ─── Status / profile payloads ──────────────────────────────────────────────

async function buildStatusPayload(userId) {
  const uid = toIdStr(userId);
  const sub = await VIPSubscription.findOne({ userId: uid }).lean();
  const level = levelFromSubscription(sub);
  const cfg = level ? vipLevelConfig(level) : null;

  return {
    isVip: !!level,
    level,
    rank: level ? vipLevelRank(level) : 0,
    status: sub ? sub.status : "none",
    startDate: sub?.startDate || null,
    expireDate: sub?.expireDate || null,
    autoRenew: sub ? !!sub.autoRenew : false,
    purchaseProvider: sub?.purchaseProvider || null,
    benefits: cfg ? publicBenefits(level) : null,
    levels: VIP_LEVELS.map((l) => publicBenefits(l)),
  };
}

// ─── Daily VIP chips ────────────────────────────────────────────────────────

async function dailyClaimState(userId, level, now = new Date()) {
  const dayUtc = utcDayStr(now);
  const claimed = await DailyVIPClaim.findOne({ userId, dayUtc }).lean();
  const cfg = level ? vipLevelConfig(level) : null;
  return {
    available: !!cfg && !claimed,
    amount: cfg ? cfg.dailyChips : 0,
    claimedToday: !!claimed,
    dayUtc,
  };
}

async function claimDailyVipChips(userId) {
  const uid = toIdStr(userId);
  const level = await getVipLevel(uid);
  if (!level) throw new ApiError("VIP membership required", 403);
  const cfg = vipLevelConfig(level);
  const now = new Date();
  const dayUtc = utcDayStr(now);

  try {
    await withMongoTransaction(async (session) => {
      // Unique {userId, dayUtc} index makes this the atomic double-claim guard.
      await DailyVIPClaim.create(
        [{ userId: uid, dayUtc, level, amount: cfg.dailyChips, claimedAt: now }],
        session ? { session } : {}
      );
      await ledgerDeposit({
        session,
        userId: uid,
        amount: cfg.dailyChips,
        meta: { source: "vip_daily_bonus", level, dayUtc },
        ledgerType: "confirmed_deposit",
      });
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      throw new ApiError("VIP daily reward already claimed today", 409);
    }
    throw e;
  }

  return { amount: cfg.dailyChips, level, dayUtc };
}

// ─── Weekly loss cashback ───────────────────────────────────────────────────

/** Sum of game losses (wins ignored) inside [start, end). */
async function computeWeeklyLosses(userId, start, end) {
  let uid = userId;
  if (typeof uid === "string" && mongoose.Types.ObjectId.isValid(uid)) {
    uid = new mongoose.Types.ObjectId(uid);
  }
  const rows = await WalletTransaction.aggregate([
    {
      $match: {
        userId: uid,
        type: { $in: CASHBACK_LOSS_TX_TYPES },
        createdAt: { $gte: start, $lt: end },
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return Math.max(0, Math.floor(rows[0]?.total || 0));
}

/**
 * Idempotently materialise the cashback row for the last completed week.
 * The unique {userId, weekKey} index makes concurrent computes safe.
 */
async function ensureWeeklyCashbackRow(userId, now = new Date()) {
  const uid = toIdStr(userId);
  const { start, end, weekKey } = previousWeekRangeUtc(now);

  const existing = await WeeklyCashback.findOne({ userId: uid, weekKey });
  if (existing) return existing;

  const level = await getVipLevel(uid);
  let losses = 0;
  let amount = 0;
  if (level) {
    losses = await computeWeeklyLosses(uid, start, end);
    amount = computeCashbackAmount(level, losses);
  }

  try {
    const created = await WeeklyCashback.create({
      userId: uid,
      weekKey,
      weekStart: start,
      weekEnd: end,
      level: level || null,
      cashbackPercent: level ? vipLevelConfig(level).cashbackPercent : 0,
      weeklyLosses: losses,
      cashbackAmount: amount,
      status: amount > 0 ? "claimable" : "none",
    });
    return created;
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      return WeeklyCashback.findOne({ userId: uid, weekKey });
    }
    throw e;
  }
}

async function claimWeeklyCashback(userId) {
  const uid = toIdStr(userId);
  const level = await getVipLevel(uid);
  if (!level) throw new ApiError("VIP membership required", 403);

  const row = await ensureWeeklyCashbackRow(uid);
  if (!row || row.status === "none" || row.cashbackAmount <= 0) {
    throw new ApiError("No cashback available for last week", 404);
  }
  if (row.status === "claimed") {
    throw new ApiError("Cashback already claimed for this week", 409);
  }

  let claimedAmount = 0;
  await withMongoTransaction(async (session) => {
    // Atomic claimable→claimed flip; loser of the race gets no document.
    const updated = await WeeklyCashback.findOneAndUpdate(
      { _id: row._id, status: "claimable" },
      { $set: { status: "claimed", claimedAt: new Date() } },
      session ? { session, new: true } : { new: true }
    );
    if (!updated) throw new ApiError("Cashback already claimed for this week", 409);
    claimedAmount = updated.cashbackAmount;
    await ledgerDeposit({
      session,
      userId: uid,
      amount: claimedAmount,
      meta: { source: "vip_weekly_cashback", weekKey: updated.weekKey, level: updated.level },
      ledgerType: "confirmed_deposit",
    });
  });

  return { amount: claimedAmount, weekKey: row.weekKey };
}

// ─── Daily quiz (Gold & Platinum) ───────────────────────────────────────────

async function assertQuizAccess(userId) {
  const level = await getVipLevel(userId);
  const cfg = level ? vipLevelConfig(level) : null;
  if (!cfg || !cfg.quiz) {
    throw new ApiError("Daily quiz is available for Gold and Platinum VIP", 403);
  }
  return level;
}

/** Server-picked deterministic question of the day for this user. */
async function pickDailyQuestion(userId, now = new Date()) {
  const dayUtc = utcDayStr(now);
  const pool = await VIPQuizQuestion.find({ isActive: true })
    .sort({ _id: 1 })
    .select("_id question options reward")
    .lean();
  if (pool.length === 0) return { dayUtc, question: null };
  const idx = dailyQuestionIndex(String(userId), dayUtc, pool.length);
  return { dayUtc, question: pool[idx] };
}

async function getDailyQuiz(userId) {
  const uid = toIdStr(userId);
  const level = await assertQuizAccess(uid);
  const now = new Date();
  const dayUtc = utcDayStr(now);

  const attempt = await VIPQuizAttempt.findOne({ userId: uid, dayUtc }).lean();
  const { question } = await pickDailyQuestion(uid, now);

  return {
    level,
    dayUtc,
    available: !!question && !attempt,
    answeredToday: !!attempt,
    lastResult: attempt
      ? { correct: attempt.correct, reward: attempt.reward, answeredAt: attempt.answeredAt }
      : null,
    question:
      question && !attempt
        ? {
            id: String(question._id),
            question: question.question,
            options: question.options,
            reward: question.reward,
          }
        : null,
  };
}

async function submitQuizAnswer(userId, { questionId, answerIndex }) {
  const uid = toIdStr(userId);
  await assertQuizAccess(uid);
  const now = new Date();
  const dayUtc = utcDayStr(now);

  const { question } = await pickDailyQuestion(uid, now);
  if (!question) throw new ApiError("No quiz question available today", 404);
  // Server authoritative: the client must answer *today's* question.
  if (String(question._id) !== String(questionId || "")) {
    throw new ApiError("Invalid quiz question", 400);
  }

  const full = await VIPQuizQuestion.findById(question._id).lean();
  if (!full || full.isActive !== true) throw new ApiError("Quiz question unavailable", 404);

  const idx = Math.floor(Number(answerIndex));
  if (!Number.isInteger(idx) || idx < 0 || idx >= full.options.length) {
    throw new ApiError("Invalid answer", 400);
  }

  const correct = idx === full.correctIndex;
  const reward = correct ? Math.max(0, Math.floor(full.reward || 0)) : 0;

  try {
    await withMongoTransaction(async (session) => {
      // Unique {userId, dayUtc} — "cannot answer twice" guard.
      await VIPQuizAttempt.create(
        [
          {
            userId: uid,
            dayUtc,
            questionId: full._id,
            answerIndex: idx,
            correct,
            reward,
            answeredAt: now,
          },
        ],
        session ? { session } : {}
      );
      if (reward > 0) {
        await ledgerDeposit({
          session,
          userId: uid,
          amount: reward,
          meta: { source: "vip_quiz_reward", dayUtc, questionId: String(full._id) },
          ledgerType: "confirmed_deposit",
        });
      }
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      throw new ApiError("Quiz already answered today", 409);
    }
    throw e;
  }

  return { correct, reward, correctIndex: full.correctIndex };
}

// ─── Expiration sweep + Monday cashback engine ──────────────────────────────

let _engineTimer = null;
let _lastCashbackSweepKey = null;

async function expireDueSubscriptions(limit = 200) {
  const now = new Date();
  const due = await VIPSubscription.find({
    status: { $in: ["active", "cancelled"] },
    expireDate: { $lte: now },
  })
    .limit(limit)
    .lean();

  for (const sub of due) {
    try {
      await withMongoTransaction(async (session) => {
        const updated = await VIPSubscription.findOneAndUpdate(
          { _id: sub._id, status: { $in: ["active", "cancelled"] } },
          { $set: { status: "expired", autoRenew: false } },
          session ? { session, new: true } : { new: true }
        );
        if (!updated) return;
        await recordHistory(
          {
            userId: sub.userId,
            action: "expiration",
            level: null,
            previousLevel: normalizeVipLevel(sub.currentLevel),
            provider: sub.purchaseProvider || null,
          },
          session
        );
        await syncUserVipFlag(sub.userId, updated, session);
      });
      await afterMembershipChanged(sub.userId);
    } catch (e) {
      logger.warn("vip_expire_failed", {
        userId: String(sub.userId),
        reason: e?.message || "unknown",
      });
    }
  }
  return due.length;
}

/** Monday: precompute last week's cashback rows for members (lazy compute covers the rest). */
async function mondayCashbackSweep(batch = 500) {
  const now = new Date();
  if (now.getUTCDay() !== 1) return 0;
  const { weekKey } = previousWeekRangeUtc(now);
  if (_lastCashbackSweepKey === weekKey) return 0;

  const subs = await VIPSubscription.find({
    status: { $in: ["active", "cancelled"] },
    expireDate: { $gt: now },
  })
    .select("userId")
    .limit(batch)
    .lean();

  let computed = 0;
  for (const s of subs) {
    try {
      await ensureWeeklyCashbackRow(s.userId, now);
      computed += 1;
    } catch (e) {
      logger.warn("vip_cashback_precompute_failed", {
        userId: String(s.userId),
        reason: e?.message || "unknown",
      });
    }
  }
  _lastCashbackSweepKey = weekKey;
  if (computed > 0) logger.info("vip_cashback_sweep_done", { weekKey, computed });
  return computed;
}

function startVipEngine() {
  if (_engineTimer) return;
  const intervalMs = Math.max(60_000, Number(process.env.VIP_ENGINE_INTERVAL_MS || 10 * 60 * 1000));
  _engineTimer = setInterval(() => {
    void expireDueSubscriptions().catch((e) =>
      logger.warn("vip_engine_expire_sweep_failed", { reason: e?.message || "unknown" })
    );
    void mondayCashbackSweep().catch((e) =>
      logger.warn("vip_engine_cashback_sweep_failed", { reason: e?.message || "unknown" })
    );
  }, intervalMs);
  if (typeof _engineTimer.unref === "function") _engineTimer.unref();
  logger.info("vip_engine_started", { intervalMs });
}

function stopVipEngineForTests() {
  if (_engineTimer) clearInterval(_engineTimer);
  _engineTimer = null;
  _lastCashbackSweepKey = null;
}

// ─── REST handlers: user routes ─────────────────────────────────────────────

exports.getStatus = asyncHandler(async (req, res) => {
  const data = await buildStatusPayload(req.user._id);
  res.status(200).json({ status: "success", data });
});

exports.getProfile = asyncHandler(async (req, res) => {
  const uid = toIdStr(req.user._id);
  const [status, history, dailyRow] = await Promise.all([
    buildStatusPayload(uid),
    VIPHistory.find({ userId: uid }).sort({ createdAt: -1 }).limit(20).lean(),
    dailyClaimState(uid, await getVipLevel(uid)),
  ]);
  const cashbackRow = status.isVip ? await ensureWeeklyCashbackRow(uid) : null;

  res.status(200).json({
    status: "success",
    data: {
      ...status,
      daily: dailyRow,
      cashback: cashbackRow
        ? {
            weekKey: cashbackRow.weekKey,
            weeklyLosses: cashbackRow.weeklyLosses,
            cashbackAmount: cashbackRow.cashbackAmount,
            cashbackPercent: cashbackRow.cashbackPercent,
            status: cashbackRow.status,
          }
        : null,
      recentHistory: history.map((h) => ({
        action: h.action,
        level: h.level,
        previousLevel: h.previousLevel,
        provider: h.provider,
        createdAt: h.createdAt,
      })),
    },
  });
});

exports.getRewards = asyncHandler(async (req, res) => {
  const uid = toIdStr(req.user._id);
  const level = await getVipLevel(uid);
  const daily = await dailyClaimState(uid, level);
  const cashbackRow = level ? await ensureWeeklyCashbackRow(uid) : null;
  const cfg = level ? vipLevelConfig(level) : null;

  let quiz = { eligible: false, available: false, answeredToday: false };
  if (cfg?.quiz) {
    try {
      const q = await getDailyQuiz(uid);
      quiz = { eligible: true, available: q.available, answeredToday: q.answeredToday };
    } catch (_) {
      quiz = { eligible: true, available: false, answeredToday: false };
    }
  }

  res.status(200).json({
    status: "success",
    data: {
      level,
      daily,
      cashback: cashbackRow
        ? {
            weekKey: cashbackRow.weekKey,
            weeklyLosses: cashbackRow.weeklyLosses,
            cashbackAmount: cashbackRow.cashbackAmount,
            cashbackPercent: cashbackRow.cashbackPercent,
            status: cashbackRow.status,
            claimable: cashbackRow.status === "claimable",
          }
        : { claimable: false, cashbackAmount: 0, status: "none" },
      quiz,
    },
  });
});

exports.postClaimDaily = asyncHandler(async (req, res) => {
  const result = await claimDailyVipChips(req.user._id);
  const Wallet = require("../models/walletModel");
  const wallet = await Wallet.findOne({ user: req.user._id }).lean();
  res.status(200).json({
    status: "success",
    data: { ...result, balance: wallet?.balance ?? 0 },
  });
});

exports.postClaimCashback = asyncHandler(async (req, res) => {
  const result = await claimWeeklyCashback(req.user._id);
  const Wallet = require("../models/walletModel");
  const wallet = await Wallet.findOne({ user: req.user._id }).lean();
  res.status(200).json({
    status: "success",
    data: { ...result, balance: wallet?.balance ?? 0 },
  });
});

exports.getQuiz = asyncHandler(async (req, res) => {
  const data = await getDailyQuiz(req.user._id);
  res.status(200).json({ status: "success", data });
});

exports.postQuiz = asyncHandler(async (req, res) => {
  const { questionId, answerIndex } = req.body || {};
  const result = await submitQuizAnswer(req.user._id, { questionId, answerIndex });
  res.status(200).json({ status: "success", data: result });
});

exports.postPurchase = asyncHandler(async (req, res, next) => {
  const level = normalizeVipLevel(req.body?.level);
  const provider = String(req.body?.provider || "").toLowerCase();
  if (!level) return next(new ApiError("Invalid VIP level", 400));
  if (!USER_PROVIDERS.includes(provider)) {
    return next(new ApiError("provider must be google_play, apple or stripe", 400));
  }

  const verdict = await validateReceipt({
    provider,
    receipt: req.body?.receipt || {},
    level,
    userId: req.user._id,
  });
  if (!verdict.ok) {
    return next(new ApiError(`Purchase validation failed: ${verdict.reason}`, 402));
  }

  await assertProviderRefUnused(verdict.providerRef);

  const { subscription, action } = await applyMembershipChange({
    userId: req.user._id,
    level,
    provider,
    providerRef: verdict.providerRef,
    kind: "purchase",
    priceCents: vipLevelConfig(level).priceCents,
  });

  res.status(200).json({
    status: "success",
    data: {
      action,
      level: subscription.currentLevel,
      expireDate: subscription.expireDate,
      status: subscription.status,
    },
  });
});

exports.postRestore = asyncHandler(async (req, res, next) => {
  const provider = String(req.body?.provider || "").toLowerCase();
  const level = normalizeVipLevel(req.body?.level);
  if (!USER_PROVIDERS.includes(provider)) {
    return next(new ApiError("provider must be google_play, apple or stripe", 400));
  }
  if (!level) return next(new ApiError("Invalid VIP level", 400));

  const verdict = await validateReceipt({
    provider,
    receipt: req.body?.receipt || {},
    level,
    userId: req.user._id,
  });
  if (!verdict.ok) {
    return next(new ApiError(`Restore validation failed: ${verdict.reason}`, 402));
  }

  // Idempotent restore: if this providerRef already backs the subscription and
  // it's still active, no state change is required.
  const existing = await getSubscription(req.user._id);
  if (
    existing &&
    existing.providerRef === verdict.providerRef &&
    levelFromSubscription(existing)
  ) {
    return res.status(200).json({
      status: "success",
      data: {
        action: "already_active",
        level: existing.currentLevel,
        expireDate: existing.expireDate,
        status: existing.status,
      },
    });
  }

  const { subscription, action } = await applyMembershipChange({
    userId: req.user._id,
    level,
    provider,
    providerRef: verdict.providerRef,
    kind: "restore",
  });

  res.status(200).json({
    status: "success",
    data: {
      action,
      level: subscription.currentLevel,
      expireDate: subscription.expireDate,
      status: subscription.status,
    },
  });
});

exports.postCancel = asyncHandler(async (req, res, next) => {
  const uid = toIdStr(req.user._id);
  const sub = await getSubscription(uid);
  if (!sub || !levelFromSubscription(sub)) {
    return next(new ApiError("No active VIP subscription", 404));
  }
  sub.autoRenew = false;
  sub.status = "cancelled";
  await sub.save();
  await recordHistory({
    userId: uid,
    action: "cancel",
    level: normalizeVipLevel(sub.currentLevel),
    previousLevel: normalizeVipLevel(sub.currentLevel),
    provider: sub.purchaseProvider || null,
  });
  await invalidateVipCache(uid);

  res.status(200).json({
    status: "success",
    data: {
      level: sub.currentLevel,
      status: sub.status,
      autoRenew: sub.autoRenew,
      // Membership remains usable until expireDate.
      expireDate: sub.expireDate,
    },
  });
});

exports.getHistory = asyncHandler(async (req, res) => {
  const uid = toIdStr(req.user._id);
  const limit = Math.min(100, parseInt(req.query.limit || "50", 10) || 50);
  const [history, claims, cashbacks] = await Promise.all([
    VIPHistory.find({ userId: uid }).sort({ createdAt: -1 }).limit(limit).lean(),
    DailyVIPClaim.find({ userId: uid }).sort({ claimedAt: -1 }).limit(limit).lean(),
    WeeklyCashback.find({ userId: uid }).sort({ createdAt: -1 }).limit(26).lean(),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      membership: history.map((h) => ({
        action: h.action,
        level: h.level,
        previousLevel: h.previousLevel,
        provider: h.provider,
        priceCents: h.priceCents || 0,
        expireDate: h.expireDate || null,
        createdAt: h.createdAt,
      })),
      dailyClaims: claims.map((c) => ({
        dayUtc: c.dayUtc,
        level: c.level,
        amount: c.amount,
        claimedAt: c.claimedAt,
      })),
      cashbacks: cashbacks.map((c) => ({
        weekKey: c.weekKey,
        level: c.level,
        weeklyLosses: c.weeklyLosses,
        cashbackAmount: c.cashbackAmount,
        cashbackPercent: c.cashbackPercent,
        status: c.status,
        claimedAt: c.claimedAt || null,
      })),
    },
  });
});

// ─── REST handlers: admin routes ────────────────────────────────────────────

exports.adminOverview = asyncHandler(async (req, res) => {
  const now = new Date();
  const [byLevel, byStatus, revenueAgg, claimsAgg, cashbackAgg, recent] = await Promise.all([
    VIPSubscription.aggregate([
      { $match: { status: { $in: ["active", "cancelled"] }, expireDate: { $gt: now } } },
      { $group: { _id: "$currentLevel", count: { $sum: 1 } } },
    ]),
    VIPSubscription.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    VIPHistory.aggregate([
      { $match: { action: { $in: ["purchase", "upgrade", "downgrade", "renewal"] } } },
      { $group: { _id: null, totalCents: { $sum: "$priceCents" }, count: { $sum: 1 } } },
    ]),
    DailyVIPClaim.aggregate([
      { $group: { _id: null, totalChips: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    WeeklyCashback.aggregate([
      { $match: { status: "claimed" } },
      { $group: { _id: null, totalChips: { $sum: "$cashbackAmount" }, count: { $sum: 1 } } },
    ]),
    VIPHistory.find({}).sort({ createdAt: -1 }).limit(30).populate("userId", "name email").lean(),
  ]);

  const activeByLevel = Object.fromEntries(VIP_LEVELS.map((l) => [l, 0]));
  for (const row of byLevel) {
    if (row._id in activeByLevel) activeByLevel[row._id] = row.count;
  }

  res.status(200).json({
    status: "success",
    data: {
      activeByLevel,
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
      purchases: {
        count: revenueAgg[0]?.count || 0,
        revenueCents: revenueAgg[0]?.totalCents || 0,
      },
      dailyClaims: {
        count: claimsAgg[0]?.count || 0,
        totalChips: claimsAgg[0]?.totalChips || 0,
      },
      cashback: {
        claimedCount: cashbackAgg[0]?.count || 0,
        totalChips: cashbackAgg[0]?.totalChips || 0,
      },
      recentEvents: recent.map((h) => ({
        user: h.userId ? { id: h.userId._id, name: h.userId.name, email: h.userId.email } : null,
        action: h.action,
        level: h.level,
        provider: h.provider,
        priceCents: h.priceCents || 0,
        createdAt: h.createdAt,
      })),
      config: VIP_LEVELS.map((l) => VIP_LEVEL_CONFIG[l]),
    },
  });
});

async function resolveTargetUser(body) {
  const rawId = String(body?.userId || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  let user = null;
  if (rawId) user = await User.findById(rawId).select("_id name email");
  if (!user && email) user = await User.findOne({ email }).select("_id name email");
  if (!user) throw new ApiError("Target user not found", 404);
  return user;
}

exports.adminGiveVip = asyncHandler(async (req, res) => {
  const user = await resolveTargetUser(req.body);
  const level = normalizeVipLevel(req.body?.level);
  if (!level) throw new ApiError("Invalid VIP level", 400);
  const days = req.body?.days;

  const { subscription, action } = await applyMembershipChange({
    userId: user._id,
    level,
    kind: "admin_gift",
    days,
    actorId: req.user._id,
    note: req.body?.note || null,
  });

  res.status(200).json({
    status: "success",
    data: {
      user: { id: user._id, name: user.name },
      action,
      level: subscription.currentLevel,
      expireDate: subscription.expireDate,
    },
  });
});

exports.adminRemoveVip = asyncHandler(async (req, res) => {
  const user = await resolveTargetUser(req.body);
  const { action } = await applyMembershipChange({
    userId: user._id,
    kind: "admin_remove",
    actorId: req.user._id,
    note: req.body?.note || null,
  });
  res.status(200).json({
    status: "success",
    data: { user: { id: user._id, name: user.name }, action },
  });
});

exports.adminUpdateVip = asyncHandler(async (req, res) => {
  const user = await resolveTargetUser(req.body);
  const mode = String(req.body?.mode || "change_level").toLowerCase();
  const level = normalizeVipLevel(req.body?.level);
  const days = req.body?.days;

  let kind = "admin_change_level";
  if (mode === "extend") kind = "admin_extend";
  if (kind === "admin_change_level" && !level) throw new ApiError("Invalid VIP level", 400);

  const sub = await getSubscription(user._id);
  if (kind === "admin_extend" && !sub) throw new ApiError("User has no VIP subscription", 404);

  const { subscription, action } = await applyMembershipChange({
    userId: user._id,
    level: level || sub?.currentLevel,
    kind,
    days,
    actorId: req.user._id,
    note: req.body?.note || null,
  });

  res.status(200).json({
    status: "success",
    data: {
      user: { id: user._id, name: user.name },
      action,
      level: subscription.currentLevel,
      expireDate: subscription.expireDate,
    },
  });
});

exports.adminListQuestions = asyncHandler(async (req, res) => {
  const rows = await VIPQuizQuestion.find({}).sort({ createdAt: -1 }).limit(500).lean();
  res.status(200).json({ status: "success", results: rows.length, data: rows });
});

exports.adminAddQuestion = asyncHandler(async (req, res) => {
  const { question, options, correctIndex, reward } = req.body || {};
  if (!question || !Array.isArray(options) || options.length < 2) {
    throw new ApiError("question and at least 2 options are required", 400);
  }
  const ci = Math.floor(Number(correctIndex));
  if (!Number.isInteger(ci) || ci < 0 || ci >= options.length) {
    throw new ApiError("correctIndex out of range", 400);
  }
  const doc = await VIPQuizQuestion.create({
    question: String(question),
    options: options.map((o) => String(o)),
    correctIndex: ci,
    reward: Math.max(0, Math.floor(Number(reward) || 0)) || undefined,
    createdBy: req.user._id,
  });
  res.status(201).json({ status: "success", data: doc });
});

exports.adminDeleteQuestion = asyncHandler(async (req, res) => {
  const id = req.params.id || req.body?.id;
  const doc = await VIPQuizQuestion.findByIdAndUpdate(
    id,
    { $set: { isActive: false } },
    { new: true }
  );
  if (!doc) throw new ApiError("Question not found", 404);
  res.status(200).json({ status: "success", data: { id: String(doc._id), isActive: doc.isActive } });
});

exports.adminUserVip = asyncHandler(async (req, res) => {
  const user = await resolveTargetUser({ userId: req.params.userId, email: req.query.email });
  const [status, history] = await Promise.all([
    buildStatusPayload(user._id),
    VIPHistory.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  res.status(200).json({
    status: "success",
    data: { user: { id: user._id, name: user.name, email: user.email }, status, history },
  });
});

// ─── Module exports (programmatic API) ──────────────────────────────────────

exports.getVipLevel = getVipLevel;
exports.getVipLevelsForUsers = getVipLevelsForUsers;
exports.peekVipLevelSync = peekVipLevelSync;
exports.invalidateVipCache = invalidateVipCache;
exports.mergeVipIntoPublicState = mergeVipIntoPublicState;
exports.levelFromSubscription = levelFromSubscription;
exports.applyMembershipChange = applyMembershipChange;
exports.claimDailyVipChips = claimDailyVipChips;
exports.ensureWeeklyCashbackRow = ensureWeeklyCashbackRow;
exports.claimWeeklyCashback = claimWeeklyCashback;
exports.computeWeeklyLosses = computeWeeklyLosses;
exports.expireDueSubscriptions = expireDueSubscriptions;
exports.mondayCashbackSweep = mondayCashbackSweep;
exports.startVipEngine = startVipEngine;
exports.stopVipEngineForTests = stopVipEngineForTests;
exports.validateReceipt = validateReceipt;
