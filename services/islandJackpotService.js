const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const IslandPool = require("../models/islandPoolModel");
const IslandMember = require("../models/islandMemberModel");
const IslandHistory = require("../models/islandHistoryModel");
const IslandWinner = require("../models/islandWinnerModel");
const JackpotTransaction = require("../models/jackpotTransactionModel");
const User = require("../models/userModel");
const ApiError = require("../utils/apiError");
const logger = require("../utils/logger");
const { isBotUserId } = require("../utils/pokerTableStatus");
const {
  evaluateIslandHand,
  compareHandTypes,
  handTypeLabel,
} = require("../utils/islandJackpotHand");
const {
  toSafeInt,
  computePoolFlags,
  calculatePayoutShares,
  isAnnouncementsEnabled,
  isEffectsEnabled,
} = require("../utils/islandJackpotLogic");
const {
  getCachedStatus,
  invalidateStatusCache,
  acquirePayoutLock,
  releasePayoutLock,
} = require("../utils/islandJackpotCache");
const {
  broadcastStateUpdate,
  broadcastPoolTick,
  broadcastHotJackpot,
  broadcastWin,
} = require("../utils/islandJackpotRealtime");
const walletLedgerService = require("./walletLedgerService");
const auditService = require("./auditService");

/** Per-user join cooldown (ms) — prevents double-click / replay spam. */
const JOIN_COOLDOWN_MS = 2500;
const _joinCooldown = new Map();

function utcDayStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isEnabledEnv() {
  return String(process.env.ISLAND_JACKPOT_ENABLED || "true").toLowerCase() !== "false";
}

function syncArmedFlags(pool) {
  const flags = computePoolFlags(pool);
  pool.armed = flags.armed;
  pool.hotJackpot = flags.hotJackpot;
  return flags;
}

async function buildStatusSnapshot(userId = null) {
  const pool = await IslandPool.getSingleton();
  const flags = computePoolFlags(pool);

  const membersCount = await IslandMember.countDocuments({ active: true });
  const dayStart = utcDayStart();
  const todayEntries = await IslandHistory.countDocuments({
    type: "join",
    createdAt: { $gte: dayStart },
  });

  let isMember = false;
  if (userId) {
    const m = await IslandMember.findOne({ userId, active: true }).lean();
    isMember = !!m;
  }

  const recentWinners = await IslandWinner.find({})
    .sort({ createdAt: -1 })
    .limit(5)
    .select("userId userName payoutAmount handType handId createdAt")
    .lean();

  const biggestWin = await IslandWinner.findOne({})
    .sort({ payoutAmount: -1 })
    .select("userId userName payoutAmount handType createdAt")
    .lean();

  return {
    enabled: isEnabledEnv() && pool.enabled !== false,
    poolBalance: flags.balance,
    minTriggerAmount: flags.minTrigger,
    hotJackpotThreshold: flags.hotThreshold,
    entryFee: toSafeInt(pool.entryFee, 50_000),
    armed: flags.armed,
    hotJackpot: flags.hotJackpot,
    settings: {
      effectsEnabled: isEffectsEnabled(pool),
      announcementsEnabled: isAnnouncementsEnabled(pool),
      hotJackpotThreshold: flags.hotThreshold,
    },
    membersCount,
    todayEntries,
    isMember,
    payoutPercentages: {
      royalFlush: pool.payoutPercentages?.royalFlush ?? 0.8,
      straightFlush: pool.payoutPercentages?.straightFlush ?? 0.3,
      fourOfAKind: pool.payoutPercentages?.fourOfAKind ?? 0.2,
    },
    payoutPolicy: {
      maxWinnersPerEvent: pool.payoutPolicy?.maxWinnersPerEvent ?? 1,
      requireShowdown: pool.payoutPolicy?.requireShowdown !== false,
      partialPoolRetention: pool.payoutPolicy?.partialPoolRetention !== false,
    },
    peakPoolBalance: toSafeInt(pool.stats?.peakPoolBalance, 0),
    totalWinners: toSafeInt(pool.stats?.totalWinners, 0),
    lastWinner: pool.lastWinner?.userId
      ? {
          userId: String(pool.lastWinner.userId),
          userName: pool.lastWinner.userName || "",
          amount: toSafeInt(pool.lastWinner.amount, 0),
          handType: pool.lastWinner.handType || "",
          handId: pool.lastWinner.handId || "",
          at: pool.lastWinner.at || null,
        }
      : null,
    recentWinners: recentWinners.map((w) => ({
      userId: String(w.userId),
      userName: w.userName || "",
      amount: w.payoutAmount,
      handType: w.handType,
      handId: w.handId,
      at: w.createdAt,
    })),
    biggestWin: biggestWin
      ? {
          userId: String(biggestWin.userId),
          userName: biggestWin.userName || "",
          amount: biggestWin.payoutAmount,
          handType: biggestWin.handType,
          at: biggestWin.createdAt,
        }
      : null,
    handRequirements: [
      { handType: "royalFlush", label: handTypeLabel("royalFlush"), percentage: pool.payoutPercentages?.royalFlush ?? 0.8 },
      { handType: "straightFlush", label: handTypeLabel("straightFlush"), percentage: pool.payoutPercentages?.straightFlush ?? 0.3 },
      { handType: "fourOfAKind", label: handTypeLabel("fourOfAKind"), percentage: pool.payoutPercentages?.fourOfAKind ?? 0.2 },
    ],
  };
}

exports.getIslandStatus = asyncHandler(async (req, res) => {
  const userId = req.user?._id || null;
  // Shared cache must stay user-agnostic — isMember is overlaid per request.
  const snapshot = await getCachedStatus(() => buildStatusSnapshot(null));
  let isMember = false;
  if (userId) {
    const m = await IslandMember.findOne({ userId, active: true }).select("_id").lean();
    isMember = !!m;
  }
  res.status(200).json({ status: "success", data: { ...snapshot, isMember } });
});

exports.getIslandHistory = asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, toSafeInt(req.query.limit, 20)));
  const rows = await IslandHistory.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.status(200).json({ status: "success", data: rows });
});

exports.getIslandWinners = asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, toSafeInt(req.query.limit, 20)));
  const rows = await IslandWinner.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("-verifiedRank")
    .lean();
  res.status(200).json({ status: "success", data: rows });
});

exports.getIslandLeaderboard = asyncHandler(async (req, res) => {
  const pool = await IslandPool.getSingleton();
  const flags = computePoolFlags(pool);

  const [topWinners, recentWinners, mostWins, topSubscribers, membersCount, todayEntries] =
    await Promise.all([
    IslandWinner.find({}).sort({ payoutAmount: -1 }).limit(10).lean(),
    IslandWinner.find({}).sort({ createdAt: -1 }).limit(10).lean(),
    IslandWinner.aggregate([
      {
        $group: {
          _id: "$userId",
          userName: { $first: "$userName" },
          wins: { $sum: 1 },
          totalWon: { $sum: "$payoutAmount" },
        },
      },
      { $sort: { wins: -1, totalWon: -1 } },
      { $limit: 10 },
    ]),
    IslandMember.find({ active: true })
      .sort({ totalContributed: -1 })
      .limit(10)
      .populate("userId", "name username")
      .lean(),
    IslandMember.countDocuments({ active: true }),
    IslandHistory.countDocuments({
      type: "join",
      createdAt: { $gte: utcDayStart() },
    }),
  ]);

  res.status(200).json({
    status: "success",
    data: {
      poolBalance: flags.balance,
      peakPoolBalance: toSafeInt(pool.stats?.peakPoolBalance, 0),
      hotJackpot: flags.hotJackpot,
      armed: flags.armed,
      membersCount,
      todayEntries,
      totalWinners: toSafeInt(pool.stats?.totalWinners, 0),
      totalPaidOut: toSafeInt(pool.stats?.totalPaidOut, 0),
      topWinners,
      recentWinners,
      mostWins: mostWins.map((r) => ({
        userId: String(r._id),
        userName: r.userName || "",
        wins: r.wins,
        totalWon: r.totalWon,
      })),
      topSubscribers: topSubscribers.map((m) => ({
        userId: String(m.userId?._id || m.userId),
        userName: m.userId?.name || m.userId?.username || "",
        totalContributed: m.totalContributed,
        winCount: m.winCount || 0,
        joinedAt: m.joinedAt,
      })),
    },
  });
});

exports.joinIslandJackpot = asyncHandler(async (req, res) => {
  if (!isEnabledEnv()) throw new ApiError("Island Jackpot is disabled", 403);

  const userId = req.user._id;
  if (isBotUserId(String(userId))) throw new ApiError("Bots cannot join", 403);

  const uid = String(userId);

  const idempotencyKey = (req.headers["idempotency-key"] || req.body?.idempotencyKey || "")
    .toString()
    .trim();
  if (idempotencyKey) {
    const dup = await JackpotTransaction.findOne({ idempotencyKey }).lean();
    if (dup) {
      const snapshot = await buildStatusSnapshot(userId);
      return res.status(200).json({ status: "success", data: { ...snapshot, duplicate: true } });
    }
  }

  const existing = await IslandMember.findOne({ userId, active: true }).lean();
  if (existing) {
    const snapshot = await buildStatusSnapshot(userId);
    return res.status(200).json({
      status: "success",
      data: { ...snapshot, alreadyMember: true },
    });
  }

  const lastJoin = _joinCooldown.get(uid) || 0;
  if (Date.now() - lastJoin < JOIN_COOLDOWN_MS) {
    throw new ApiError("Please wait before joining again", 429);
  }

  const pool = await IslandPool.getSingleton();
  if (!pool.enabled) throw new ApiError("Island Jackpot is disabled", 403);

  const fee = toSafeInt(pool.entryFee, 0);
  if (fee <= 0) throw new ApiError("Invalid entry fee configuration", 500);

  const txnId = crypto.randomUUID();
  let resultSnapshot = null;
  let enteredHot = false;
  const wasHotBefore = computePoolFlags(pool).hotJackpot;

  await walletLedgerService.withMongoTransaction(async (session) => {
    await walletLedgerService.ledgerWithdraw({
      session,
      userId,
      amount: fee,
      ledgerType: "island_jackpot_entry",
      meta: { source: "island_jackpot", txnId },
    });

    const freshPool = await IslandPool.findOne({ key: "default" }).session(session);
    freshPool.poolBalance = toSafeInt(freshPool.poolBalance, 0) + fee;
    freshPool.stats = freshPool.stats || {};
    freshPool.stats.totalEntries = toSafeInt(freshPool.stats.totalEntries, 0) + 1;
    if (freshPool.poolBalance > toSafeInt(freshPool.stats.peakPoolBalance, 0)) {
      freshPool.stats.peakPoolBalance = freshPool.poolBalance;
    }
    syncArmedFlags(freshPool);
    enteredHot = !wasHotBefore && computePoolFlags(freshPool).hotJackpot;
    freshPool.version = toSafeInt(freshPool.version, 0) + 1;
    await freshPool.save(session ? { session } : undefined);

    const [history] = await IslandHistory.create(
      [
        {
          type: "join",
          userId,
          amount: fee,
          poolAfter: freshPool.poolBalance,
          meta: { txnId },
        },
      ],
      session ? { session } : undefined
    );

    await IslandMember.create(
      [
        {
          userId,
          active: true,
          totalContributed: fee,
          lastEntryTxnId: txnId,
        },
      ],
      session ? { session } : undefined
    );

    await JackpotTransaction.create(
      [
        {
          txnId,
          userId,
          direction: "debit_entry",
          amount: fee,
          islandHistoryId: history._id,
          idempotencyKey: idempotencyKey || undefined,
          status: "completed",
          meta: { entryFee: fee },
        },
      ],
      session ? { session } : undefined
    );
  });

  await invalidateStatusCache();
  resultSnapshot = await buildStatusSnapshot(userId);
  _joinCooldown.set(uid, Date.now());

  if (isEffectsEnabled(pool)) {
    broadcastPoolTick({
    poolBalance: resultSnapshot.poolBalance,
    membersCount: resultSnapshot.membersCount,
    todayEntries: resultSnapshot.todayEntries,
    hotJackpot: resultSnapshot.hotJackpot,
      delta: fee,
    });
  }

  if (enteredHot && isAnnouncementsEnabled(pool)) {
    await IslandHistory.create({
      type: "hot_entered",
      amount: 0,
      poolAfter: resultSnapshot.poolBalance,
      meta: { minTrigger: resultSnapshot.minTriggerAmount },
    });
    broadcastHotJackpot({
      poolBalance: resultSnapshot.poolBalance,
      minTriggerAmount: resultSnapshot.minTriggerAmount,
    });
  }

  res.status(200).json({ status: "success", data: resultSnapshot });
});

/** Admin: read config */
exports.adminGetConfig = asyncHandler(async (req, res) => {
  const pool = await IslandPool.getSingleton();
  res.status(200).json({ status: "success", data: pool });
});

/** Admin: update config */
exports.adminUpdateConfig = asyncHandler(async (req, res) => {
  const pool = await IslandPool.getSingleton();
  const body = req.body || {};

  if (body.enabled != null) pool.enabled = !!body.enabled;
  if (body.minTriggerAmount != null) pool.minTriggerAmount = Math.max(0, toSafeInt(body.minTriggerAmount, pool.minTriggerAmount));
  if (body.entryFee != null) pool.entryFee = Math.max(0, toSafeInt(body.entryFee, pool.entryFee));

  if (body.payoutPercentages && typeof body.payoutPercentages === "object") {
    pool.payoutPercentages = {
      ...pool.payoutPercentages?.toObject?.() || pool.payoutPercentages || {},
      ...body.payoutPercentages,
    };
  }
  if (body.payoutPolicy && typeof body.payoutPolicy === "object") {
    pool.payoutPolicy = {
      ...pool.payoutPolicy?.toObject?.() || pool.payoutPolicy || {},
      ...body.payoutPolicy,
    };
  }
  if (body.settings && typeof body.settings === "object") {
    pool.settings = {
      ...pool.settings?.toObject?.() || pool.settings || {},
      ...body.settings,
    };
  }

  syncArmedFlags(pool);
  pool.version = toSafeInt(pool.version, 0) + 1;
  await pool.save();
  await invalidateStatusCache();

  await auditService.logEvent({
    event: "island_jackpot_config_updated",
    user: req.user._id,
    meta: body,
  });

  broadcastStateUpdate(await buildStatusSnapshot());
  res.status(200).json({ status: "success", data: pool });
});

exports.adminResetPool = asyncHandler(async (req, res) => {
  const pool = await IslandPool.getSingleton();
  const before = toSafeInt(pool.poolBalance, 0);
  pool.poolBalance = 0;
  pool.armed = false;
  pool.hotJackpot = false;
  pool.version = toSafeInt(pool.version, 0) + 1;
  await pool.save();

  await IslandHistory.create({
    type: "admin_adjust",
    userId: req.user._id,
    amount: -before,
    poolAfter: 0,
    meta: { reason: "admin_reset" },
  });

  await invalidateStatusCache();
  await auditService.logEvent({
    event: "island_jackpot_pool_reset",
    user: req.user._id,
    meta: { before },
  });

  broadcastStateUpdate(await buildStatusSnapshot());
  res.status(200).json({ status: "success", data: { poolBalance: 0 } });
});

exports.adminGetStatistics = asyncHandler(async (req, res) => {
  const pool = await IslandPool.getSingleton();
  const membersCount = await IslandMember.countDocuments({ active: true });
  const totalEntries = await IslandHistory.countDocuments({ type: "join" });
  const totalPayouts = await IslandWinner.countDocuments({});
  const sumPaid = await IslandWinner.aggregate([
    { $group: { _id: null, total: { $sum: "$payoutAmount" } } },
  ]);

  res.status(200).json({
    status: "success",
    data: {
      pool,
      membersCount,
      totalEntries,
      totalPayouts,
      totalPaidOut: sumPaid[0]?.total || 0,
    },
  });
});

/**
 * Freeze Island eligibility, policy and amount inside the hand settlement
 * transaction.  The worker later performs only the already-authorized wallet
 * credits; it must never re-evaluate current members or the current pool.
 */
async function reservePayoutForHand({ session = null, handId, tableId, gameType, community = [], seats = [], handCategory = null, reason = null }) {
  if (!isEnabledEnv()) return { status: "skipped", reason: "disabled" };
  if (gameType !== "poker" || !handId) return { status: "skipped", reason: "invalid_hand" };

  const poolQuery = IslandPool.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const pool = session ? await poolQuery.session(session) : await poolQuery;
  if (!pool || !pool.enabled) return { status: "skipped", reason: "pool_disabled" };
  if (!computePoolFlags(pool).armed) return { status: "skipped", reason: "not_armed" };
  if (pool.payoutPolicy?.requireShowdown !== false && reason && reason !== "showdown") {
    return { status: "skipped", reason: "not_showdown" };
  }

  const candidates = (seats || []).filter((seat) =>
    seat && !seat.isBot && !isBotUserId(String(seat.userId || "")) && !seat.folded &&
    Array.isArray(seat.hole) && seat.hole.length >= 2
  );
  if (!candidates.length) return { status: "skipped", reason: "no_candidates" };

  const memberIds = candidates.map((seat) => seat.userId);
  const memberQuery = IslandMember.find({ userId: { $in: memberIds }, active: true });
  const activeMembers = session ? await memberQuery.session(session).lean() : await memberQuery.lean();
  const members = new Set(activeMembers.map((member) => String(member.userId)));
  const qualifiers = [];
  for (const seat of candidates) {
    if (!members.has(String(seat.userId))) continue;
    const evaluated = evaluateIslandHand(seat.hole, community);
    if (!evaluated) continue;
    qualifiers.push({
      userId: seat.userId,
      userName: seat.name || "",
      handType: evaluated.handType,
      rank: evaluated.rank,
      hole: [...seat.hole],
    });
  }
  if (!qualifiers.length) return { status: "skipped", reason: "no_qualifiers" };

  qualifiers.sort((a, b) => compareHandTypes(b.handType, a.handType));
  const handType = qualifiers[0].handType;
  const maxWinners = Math.min(2, Math.max(1, toSafeInt(pool.payoutPolicy?.maxWinnersPerEvent, 1)));
  const winners = qualifiers.filter((q) => q.handType === handType).slice(0, maxWinners);
  const percentage = Number(pool.payoutPercentages?.[handType] || 0);
  const payout = calculatePayoutShares(pool.poolBalance, percentage, winners.length);
  if (!payout) return { status: "skipped", reason: "no_payout_plan" };

  const poolBefore = toSafeInt(pool.poolBalance, 0);
  if (poolBefore < payout.actualTotal) throw new Error("INSUFFICIENT_POOL");
  pool.poolBalance = poolBefore - payout.actualTotal;
  pool.stats = pool.stats || {};
  pool.stats.totalPaidOut = toSafeInt(pool.stats.totalPaidOut, 0) + payout.actualTotal;
  pool.stats.totalWinners = toSafeInt(pool.stats.totalWinners, 0) + winners.length;
  const last = winners[winners.length - 1];
  pool.lastWinner = {
    userId: last.userId,
    userName: last.userName,
    amount: payout.shareEach,
    handType,
    handId: String(handId),
    at: new Date(),
  };
  syncArmedFlags(pool);
  pool.version = toSafeInt(pool.version, 0) + 1;
  await pool.save(session ? { session } : undefined);

  return {
    status: "reserved",
    handId: String(handId),
    tableId: tableId ? String(tableId) : null,
    community: [...community],
    handCategory,
    poolVersion: toSafeInt(pool.version, 0),
    poolBefore,
    poolAfter: toSafeInt(pool.poolBalance, 0),
    percentage,
    handType,
    shareEach: payout.shareEach,
    actualTotal: payout.actualTotal,
    winners,
    announcementsEnabled: isAnnouncementsEnabled(pool),
    effectsEnabled: isEffectsEnabled(pool),
  };
}

async function executeReservedPayout(plan) {
  if (!plan || plan.status !== "reserved") return { status: "skipped", reason: plan?.reason || "not_eligible" };
  const handId = String(plan.handId);
  const winners = Array.isArray(plan.winners) ? plan.winners : [];
  if (!winners.length || !plan.shareEach) return { status: "skipped", reason: "invalid_reservation" };

  const alreadyPaid = await IslandWinner.exists({ handId });
  if (alreadyPaid) return { status: "completed", reason: "already_paid" };

  await walletLedgerService.withMongoTransaction(async (session) => {
    const duplicate = await IslandWinner.findOne({ handId })
      .select("_id")
      .session(session)
      .lean();
    if (duplicate) return;
    for (const winner of winners) {
      const payoutTxnId = crypto.randomUUID();
      await walletLedgerService.ledgerDeposit({
        session,
        userId: winner.userId,
        amount: plan.shareEach,
        ledgerType: "island_jackpot_win",
        meta: { source: "island_jackpot", handId, handType: plan.handType, tableId: plan.tableId },
      });
      const [history] = await IslandHistory.create([{
        type: "payout",
        userId: winner.userId,
        amount: plan.shareEach,
        poolAfter: plan.poolAfter,
        handId,
        handType: plan.handType,
      }], session ? { session } : undefined);
      await IslandWinner.create([{
        userId: winner.userId,
        userName: winner.userName,
        handId,
        handType: plan.handType,
        payoutAmount: plan.shareEach,
        poolBefore: plan.poolBefore,
        poolAfter: plan.poolAfter,
        percentage: plan.percentage,
        tableId: plan.tableId || undefined,
        holeCards: winner.hole,
        communityCards: plan.community || [],
        verifiedRank: { cat: winner.rank?.cat, tiebreak: winner.rank?.tiebreak || [] },
      }], session ? { session } : undefined);
      await IslandMember.updateOne({ userId: winner.userId }, { $inc: { winCount: 1 } }, session ? { session } : undefined);
      await JackpotTransaction.create([{
        txnId: payoutTxnId,
        userId: winner.userId,
        direction: "credit_payout",
        amount: plan.shareEach,
        islandHistoryId: history._id,
        status: "completed",
        meta: { handId, handType: plan.handType },
      }], session ? { session } : undefined);
    }
  });

  const users = await User.find({ _id: { $in: winners.map((winner) => winner.userId) } })
    .select("name username profileImg").lean();
  const userMap = new Map(users.map((user) => [String(user._id), user]));
  if (plan.announcementsEnabled) {
    for (const winner of winners) {
      const user = userMap.get(String(winner.userId));
      broadcastWin({
        userId: String(winner.userId),
        userName: user?.name || user?.username || winner.userName || "Player",
        avatarUrl: user?.profileImg || "",
        amount: plan.shareEach,
        handType: plan.handType,
        handLabel: handTypeLabel(plan.handType),
        handId,
        poolAfter: plan.poolAfter,
        percentage: plan.percentage,
        globalAnnouncement: true,
      });
    }
  }
  await invalidateStatusCache();
  if (plan.effectsEnabled) broadcastStateUpdate(await buildStatusSnapshot());
  return { status: "completed", winners: winners.length, totalPayout: plan.actualTotal };
}

/**
 * Post-hand hook — fire-and-forget from phase3HandArchiveService.
 */
async function onHandSettled({
  handId,
  tableId,
  gameType,
  community = [],
  seats = [],
  handCategory = null,
  reason = null,
  settlementPlan = null,
}) {
  if (settlementPlan) return executeReservedPayout(settlementPlan);
  if (!isEnabledEnv()) return { status: "skipped", reason: "disabled" };
  if (gameType !== "poker") return { status: "skipped", reason: "game_type" };
  if (!handId) return { status: "skipped", reason: "missing_hand_id" };

  const pool = await IslandPool.getSingleton();
  if (!pool.enabled) return { status: "skipped", reason: "pool_disabled" };

  const armedFlags = computePoolFlags(pool);
  if (!armedFlags.armed) return { status: "skipped", reason: "not_armed" };

  const requireShowdown = pool.payoutPolicy?.requireShowdown !== false;
  if (requireShowdown && reason && reason !== "showdown") {
    return { status: "skipped", reason: "not_showdown" };
  }

  const existingForHand = await IslandWinner.countDocuments({ handId: String(handId) });
  if (existingForHand > 0) return { status: "completed", reason: "already_paid" };

  const lock = await acquirePayoutLock(String(handId));
  if (!lock.acquired) return { status: "deferred", reason: "payout_lock_busy" };

  try {
    const candidateSeats = (seats || []).filter(
      (seat) =>
        seat &&
        !seat.isBot &&
        !isBotUserId(String(seat.userId || "")) &&
        !seat.folded &&
        Array.isArray(seat.hole) &&
        seat.hole.length >= 2
    );
    if (candidateSeats.length === 0) return { status: "skipped", reason: "no_candidates" };

    const memberIds = candidateSeats.map((s) => s.userId);
    const activeMembers = await IslandMember.find({
      userId: { $in: memberIds },
      active: true,
    }).lean();
    const memberSet = new Set(activeMembers.map((m) => String(m.userId)));

    const qualifiers = [];
    for (const seat of candidateSeats) {
      if (!memberSet.has(String(seat.userId))) continue;
      const evaluated = evaluateIslandHand(seat.hole, community);
      if (!evaluated) continue;
      qualifiers.push({
        userId: seat.userId,
        userName: seat.name || "",
        handType: evaluated.handType,
        rank: evaluated.rank,
        hole: [...seat.hole],
      });
    }

    if (qualifiers.length === 0) return { status: "skipped", reason: "no_qualifiers" };

    qualifiers.sort((a, b) => compareHandTypes(b.handType, a.handType));
    const bestType = qualifiers[0].handType;
    const topTier = qualifiers.filter((q) => q.handType === bestType);

    const maxWinners = Math.min(
      2,
      Math.max(1, toSafeInt(pool.payoutPolicy?.maxWinnersPerEvent, 1))
    );
    const winners = topTier.slice(0, maxWinners);

    const pct = pool.payoutPercentages?.[bestType];
    const payoutPlan = calculatePayoutShares(pool.poolBalance, pct, winners.length);
    if (!payoutPlan) return { status: "skipped", reason: "no_payout_plan" };

    const { shareEach, actualTotal } = payoutPlan;
    const poolBefore = toSafeInt(pool.poolBalance, 0);
    const percentage = Number(pct);
    const paidWinners = [];

    await walletLedgerService.withMongoTransaction(async (session) => {
      const freshPool = await IslandPool.findOne({ key: "default" }).session(session);
      if (toSafeInt(freshPool.poolBalance, 0) < actualTotal) {
        throw new Error("INSUFFICIENT_POOL");
      }

      freshPool.poolBalance = toSafeInt(freshPool.poolBalance, 0) - actualTotal;
      freshPool.stats = freshPool.stats || {};
      freshPool.stats.totalPaidOut = toSafeInt(freshPool.stats.totalPaidOut, 0) + actualTotal;
      freshPool.stats.totalWinners = toSafeInt(freshPool.stats.totalWinners, 0) + winners.length;

      const last = winners[winners.length - 1];
      freshPool.lastWinner = {
        userId: last.userId,
        userName: last.userName,
        amount: shareEach,
        handType: bestType,
        handId: String(handId),
        at: new Date(),
      };
      syncArmedFlags(freshPool);
      freshPool.version = toSafeInt(freshPool.version, 0) + 1;
      await freshPool.save(session ? { session } : undefined);

      for (const winner of winners) {
        const dup = await IslandWinner.findOne({
          handId: String(handId),
          userId: winner.userId,
        }).session(session);
        if (dup) throw new Error("DUPLICATE_PAYOUT");

        const payoutTxnId = crypto.randomUUID();

        await walletLedgerService.ledgerDeposit({
          session,
          userId: winner.userId,
          amount: shareEach,
          ledgerType: "island_jackpot_win",
          meta: {
            source: "island_jackpot",
            handId: String(handId),
            handType: bestType,
            tableId: tableId ? String(tableId) : null,
          },
        });

        const [history] = await IslandHistory.create(
          [
            {
              type: "payout",
              userId: winner.userId,
              amount: shareEach,
              poolAfter: freshPool.poolBalance,
              handId: String(handId),
              handType: bestType,
            },
          ],
          session ? { session } : undefined
        );

        await IslandWinner.create(
          [
            {
              userId: winner.userId,
              userName: winner.userName,
              handId: String(handId),
              handType: bestType,
              payoutAmount: shareEach,
              poolBefore,
              poolAfter: freshPool.poolBalance,
              percentage,
              tableId: tableId || undefined,
              holeCards: winner.hole,
              communityCards: [...(community || [])],
              verifiedRank: {
                cat: winner.rank?.cat,
                tiebreak: winner.rank?.tiebreak || [],
              },
            },
          ],
          session ? { session } : undefined
        );

        await IslandMember.updateOne(
          { userId: winner.userId },
          { $inc: { winCount: 1 } },
          session ? { session } : undefined
        );

        await JackpotTransaction.create(
          [
            {
              txnId: payoutTxnId,
              userId: winner.userId,
              direction: "credit_payout",
              amount: shareEach,
              islandHistoryId: history._id,
              status: "completed",
              meta: { handId: String(handId), handType: bestType },
            },
          ],
          session ? { session } : undefined
        );

        paidWinners.push(winner);
      }
    });

    const userIds = paidWinners.map((w) => w.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("name username profileImg")
      .lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    for (const winner of paidWinners) {
      const user = userMap.get(String(winner.userId));
      const displayName = user?.name || user?.username || winner.userName || "Player";

      if (isAnnouncementsEnabled(pool)) {
        broadcastWin({
          userId: String(winner.userId),
          userName: displayName,
          avatarUrl: user?.profileImg || "",
          amount: shareEach,
          handType: bestType,
          handLabel: handTypeLabel(bestType),
          handId: String(handId),
          poolAfter: poolBefore - actualTotal,
          percentage,
          globalAnnouncement: true,
        });
      }
    }

    await invalidateStatusCache();
    if (isEffectsEnabled(pool)) {
      broadcastStateUpdate(await buildStatusSnapshot());
    }

    logger.info("island_jackpot_payout", {
      handId: String(handId),
      handType: bestType,
      winners: paidWinners.length,
      totalPayout: actualTotal,
      handCategory,
    });
    return { status: "completed", winners: paidWinners.length, totalPayout: actualTotal };
  } catch (err) {
    if (err?.message === "DUPLICATE_PAYOUT") {
      logger.warn("island_jackpot_duplicate_blocked", { handId: String(handId) });
      return { status: "completed", reason: "duplicate_payout" };
    } else {
      logger.error("island_jackpot_payout_failed", {
        handId: String(handId),
        reason: err?.message || "unknown",
      });
      throw err;
    }
  } finally {
    await releasePayoutLock(lock.key);
  }
}

exports.onHandSettled = onHandSettled;
exports.reservePayoutForHand = reservePayoutForHand;
exports.buildStatusSnapshot = buildStatusSnapshot;
exports.resetJoinCooldownForTests = () => _joinCooldown.clear();

// ─── House daily fill: +10,000,000 coins once per UTC day ───────────────────
const DAILY_FILL_AMOUNT = Math.max(0, toSafeInt(process.env.ISLAND_DAILY_FILL_AMOUNT, 10_000_000));
const DAILY_FILL_CHECK_MS = 5 * 60 * 1000;

let _autoFillTimer = null;

function utcDayKey(d = new Date()) {
  return utcDayStart(d).toISOString().slice(0, 10);
}

/**
 * Adds DAILY_FILL_AMOUNT to the pool once per UTC calendar day.
 * Atomic on lastDailyFillDayUtc so multi-instance boots cannot double-fill.
 */
async function applyDailyFill(now = new Date()) {
  if (DAILY_FILL_AMOUNT <= 0) return { applied: false, reason: "disabled" };

  const dayKey = utcDayKey(now);
  await IslandPool.getSingleton();

  const updated = await IslandPool.findOneAndUpdate(
    {
      key: "default",
      lastDailyFillDayUtc: { $ne: dayKey },
    },
    {
      $inc: { poolBalance: DAILY_FILL_AMOUNT, version: 1 },
      $set: { lastDailyFillDayUtc: dayKey },
    },
    { new: true }
  );

  if (!updated) return { applied: false, reason: "already_filled", dayUtc: dayKey };

  if (!updated.stats) updated.stats = {};
  if (updated.poolBalance > toSafeInt(updated.stats.peakPoolBalance, 0)) {
    updated.stats.peakPoolBalance = updated.poolBalance;
  }
  syncArmedFlags(updated);
  await updated.save();

  try {
    await IslandHistory.create({
      type: "daily_fill",
      amount: DAILY_FILL_AMOUNT,
      poolAfter: updated.poolBalance,
      meta: { dayUtc: dayKey },
    });
  } catch (histErr) {
    logger.warn("island_daily_fill_history_failed", { reason: histErr?.message || "unknown" });
  }

  await invalidateStatusCache();
  broadcastPoolTick(updated.poolBalance);
  if (updated.hotJackpot) broadcastHotJackpot(true);

  logger.info("island_daily_fill", {
    amount: DAILY_FILL_AMOUNT,
    poolAfter: updated.poolBalance,
    dayUtc: dayKey,
  });

  return { applied: true, poolBalance: updated.poolBalance, dayUtc: dayKey };
}

async function _dailyFillTick() {
  try {
    await applyDailyFill();
  } catch (err) {
    logger.warn("island_daily_fill_error", { reason: err?.message || "unknown" });
  }
}

function startAutoFill() {
  if (_autoFillTimer) return;
  _autoFillTimer = setInterval(_dailyFillTick, DAILY_FILL_CHECK_MS);
  _autoFillTimer.unref?.();
  const boot = setTimeout(_dailyFillTick, 3000);
  boot.unref?.();
}

function stopAutoFill() {
  if (_autoFillTimer) {
    clearInterval(_autoFillTimer);
    _autoFillTimer = null;
  }
}

exports.startAutoFill = startAutoFill;
exports.stopAutoFill = stopAutoFill;
exports.applyDailyFill = applyDailyFill;
exports.DAILY_FILL_AMOUNT = DAILY_FILL_AMOUNT;
exports.utcDayKey = utcDayKey;
