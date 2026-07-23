const ApiError = require("../utils/apiError");
const Clan = require("../models/clanModel");
const ClanMember = require("../models/clanMemberModel");
const ClanTreasuryTransaction = require("../models/clanTreasuryTransactionModel");
const { withMongoTransaction, ledgerWithdraw } = require("./walletLedgerService");
const clanService = require("./clanService");
const clanRealtime = require("./clanRealtime");

function toInt(v) {
  return Math.floor(Number(v) || 0);
}

// ─── in-session treasury movers (reused by donations, tournaments, events) ────
/** Credit the treasury inside the caller's txn and append the audit row. */
async function creditTreasuryInSession(session, clanId, amount, { type, user = null, meta = {} }) {
  const amt = toInt(amount);
  if (amt <= 0) throw new ApiError("Invalid amount", 400);
  const clan = await Clan.findOneAndUpdate(
    { _id: clanId, status: "active" },
    { $inc: { "treasury.balance": amt } },
    { new: true, ...(session ? { session } : {}) }
  );
  if (!clan) throw new ApiError("Clan not available", 404);
  await ClanTreasuryTransaction.create(
    [{ clan: clanId, type, direction: "in", amount: amt, user, balanceAfter: clan.treasury.balance, meta }],
    session ? { session } : {}
  );
  return clan.treasury.balance;
}

/** Debit the treasury (guarded so it can never go negative). */
async function debitTreasuryInSession(session, clanId, amount, { type, user = null, meta = {} }) {
  const amt = toInt(amount);
  if (amt <= 0) throw new ApiError("Invalid amount", 400);
  const clan = await Clan.findOneAndUpdate(
    { _id: clanId, "treasury.balance": { $gte: amt } },
    { $inc: { "treasury.balance": -amt } },
    { new: true, ...(session ? { session } : {}) }
  );
  if (!clan) throw new ApiError("Insufficient treasury balance", 402);
  await ClanTreasuryTransaction.create(
    [{ clan: clanId, type, direction: "out", amount: amt, user, balanceAfter: clan.treasury.balance, meta }],
    session ? { session } : {}
  );
  return clan.treasury.balance;
}

// ─── donations ──────────────────────────────────────────────────────────────
async function donate(userId, clanId, amount) {
  const amt = toInt(amount);
  const settings = await clanService.getSettings();
  if (!settings.treasuryEnabled) throw new ApiError("Treasury is disabled", 403);
  if (amt < settings.minDonation) {
    throw new ApiError(`Minimum donation is ${settings.minDonation}`, 400);
  }
  const member = await ClanMember.findOne({ clan: clanId, user: userId }).lean();
  if (!member) throw new ApiError("You are not a member of this clan", 403);

  /**
   * Claim the per-user daily allowance ATOMICALLY before moving any coins.
   * A read-then-write check (aggregate past donations, compare, then insert) lets
   * concurrent donations all observe the same stale total and blow through the
   * cap. This single conditional update both resets a stale day-bucket and adds
   * the amount, matching only while the resulting total stays within the limit.
   */
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const now = new Date();
  let capClaimed = false;

  if (settings.donationDailyLimit > 0) {
    // Today's counted total: 0 when the bucket is from a previous day.
    const countedToday = {
      $cond: [
        { $lt: [{ $ifNull: ["$contribution.dailyDonatedAt", new Date(0)] }, startOfDay] },
        0,
        { $ifNull: ["$contribution.dailyDonated", 0] },
      ],
    };
    const claim = await ClanMember.findOneAndUpdate(
      {
        clan: clanId,
        user: userId,
        $expr: { $lte: [{ $add: [countedToday, amt] }, settings.donationDailyLimit] },
      },
      [
        {
          $set: {
            "contribution.dailyDonated": { $add: [countedToday, amt] },
            "contribution.dailyDonatedAt": now,
          },
        },
      ],
      { new: true }
    );
    if (!claim) throw new ApiError("Daily donation limit reached", 429);
    capClaimed = true;
  }

  let newBalance;
  try {
    newBalance = await withMongoTransaction(async (session) => {
      await ledgerWithdraw({
        session,
        userId,
        amount: amt,
        ledgerType: "clan_donation",
        meta: { source: "clan_donation", clanId: String(clanId) },
      });
      const bal = await creditTreasuryInSession(session, clanId, amt, {
        type: "donation",
        user: userId,
      });
      await ClanMember.updateOne(
        { clan: clanId, user: userId },
        { $inc: { "contribution.donated": amt } },
        session ? { session } : {}
      );
      return bal;
    });
  } catch (err) {
    // The donation never happened — give the daily allowance back so a failed
    // attempt doesn't silently consume the player's cap.
    if (capClaimed) {
      await ClanMember.updateOne(
        { clan: clanId, user: userId },
        { $inc: { "contribution.dailyDonated": -amt } }
      ).catch(() => {});
    }
    if (err && err.message === "INSUFFICIENT_BALANCE") {
      throw new ApiError("Insufficient coins", 402);
    }
    throw err;
  }

  clanRealtime.emitToClan(clanId, "clan:treasury_update", { balance: newBalance });
  return { balance: newBalance, donated: amt };
}

// ─── reads ────────────────────────────────────────────────────────────────────
async function getTreasury(clanId) {
  const clan = await Clan.findById(clanId).select("treasury status").lean();
  if (!clan || clan.status === "deleted") throw new ApiError("Clan not found", 404);
  const settings = await clanService.getSettings();
  return {
    balance: clan.treasury?.balance || 0,
    enabled: settings.treasuryEnabled,
    minDonation: settings.minDonation,
    dailyLimit: settings.donationDailyLimit,
  };
}

async function listTransactions(clanId, { page = 1, limit = 30 } = {}) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
  const [rows, total] = await Promise.all([
    ClanTreasuryTransaction.find({ clan: clanId })
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .skip((pg - 1) * lim)
      .limit(lim)
      .lean(),
    ClanTreasuryTransaction.countDocuments({ clan: clanId }),
  ]);
  return {
    total,
    page: pg,
    limit: lim,
    data: rows.map((r) => ({
      id: String(r._id),
      type: r.type,
      direction: r.direction,
      amount: r.amount,
      balanceAfter: r.balanceAfter,
      userName: r.user?.name || null,
      meta: r.meta || {},
      createdAt: r.createdAt,
    })),
  };
}

/** Admin-initiated adjustment (grant/deduct). Used by the admin surface. */
async function adminAdjust(clanId, amount, direction, meta = {}) {
  const amt = toInt(amount);
  if (amt <= 0) throw new ApiError("Invalid amount", 400);
  return withMongoTransaction((session) =>
    direction === "out"
      ? debitTreasuryInSession(session, clanId, amt, { type: "admin_adjust", meta })
      : creditTreasuryInSession(session, clanId, amt, { type: "admin_adjust", meta })
  );
}

module.exports = {
  donate,
  getTreasury,
  listTransactions,
  adminAdjust,
  creditTreasuryInSession,
  debitTreasuryInSession,
};
