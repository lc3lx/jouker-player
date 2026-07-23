/**
 * Economy health checks: orphaned WalletTableLock rows, negative-balance
 * detection, house-wallet floor, and a delta-based global conservation
 * sweep. Read-only for real money movements except the two explicitly
 * safe repairs (deleting a zero-amount orphan lock; refunding a
 * long-orphaned funded lock via the same releaseTableSeatToBalance every
 * normal leave already uses).
 */
const WalletTableLock = require("../../models/walletTableLockModel");
const Wallet = require("../../models/walletModel");
const WalletTransaction = require("../../models/walletTransactionModel");
const Table = require("../../models/tableModel");
const HouseWallet = require("../../models/houseWalletModel");
const { releaseTableSeatToBalance, withMongoTransaction } = require("../walletLedgerService");

function makeFinding({ check, severity, tableId = null, playerId = null, message, meta = {} }) {
  return {
    check,
    severity,
    tableId: tableId ? String(tableId) : null,
    playerId: playerId ? String(playerId) : null,
    socketId: null,
    message,
    meta,
    repaired: false,
    repairAction: null,
    repairResult: null,
  };
}

/**
 * A WalletTableLock with funds attributed to a (user, table) pair that no
 * longer references that user anywhere (seats/vacatingPlayers/waitingQueue).
 * updatedAt is used as the "orphaned since" proxy — any legitimate lock gets
 * touched whenever its seat's money moves, so a stale updatedAt on an
 * unreferenced lock means it's been sitting orphaned, not just mid-transition.
 */
async function checkOrphanWalletLocks({ walletLockOrphanGraceMs, autoRepairEnabled }) {
  const findings = [];
  const cutoff = new Date(Date.now() - walletLockOrphanGraceMs);

  const groups = await WalletTableLock.aggregate([
    { $match: { updatedAt: { $lt: cutoff } } },
    {
      $group: {
        _id: "$table",
        locks: { $push: { lockId: "$_id", user: "$user", amount: "$amount" } },
      },
    },
    { $limit: 500 },
  ]);

  for (const group of groups) {
    const table = await Table.findById(group._id).select("seats vacatingPlayers waitingQueue gameType tableNumber");
    const referenced = new Set();
    if (table) {
      for (const s of table.seats || []) referenced.add(String(s.user));
      for (const v of table.vacatingPlayers || []) referenced.add(String(v.user));
      for (const q of table.waitingQueue || []) referenced.add(String(q.user));
    }

    for (const lock of group.locks) {
      const uid = String(lock.user);
      if (table && referenced.has(uid)) continue; // still legitimately attributed

      const finding = makeFinding({
        check: "orphan_wallet_table_lock",
        severity: lock.amount > 0 ? "critical" : "warning",
        tableId: group._id,
        playerId: uid,
        message: table
          ? `WalletTableLock for user ${uid} on table ${group._id} (${lock.amount}) has no matching seat/vacating/queue entry`
          : `WalletTableLock for user ${uid} references table ${group._id}, which no longer exists`,
        meta: { lockId: String(lock.lockId), amount: lock.amount, tableExists: !!table },
      });

      if (autoRepairEnabled) {
        try {
          if (lock.amount <= 0) {
            await WalletTableLock.deleteOne({ _id: lock.lockId });
            finding.repaired = true;
            finding.repairAction = "delete_zero_amount_lock";
            finding.repairResult = "success";
          } else {
            await withMongoTransaction(async (session) => {
              await releaseTableSeatToBalance({
                session,
                userId: uid,
                seatChips: lock.amount,
                tableId: group._id,
                meta: { reason: "monitor_orphan_lock_refund" },
              });
            });
            finding.repaired = true;
            finding.repairAction = "releaseTableSeatToBalance";
            finding.repairResult = "success";
          }
        } catch (e) {
          finding.repaired = false;
          finding.repairAction = lock.amount > 0 ? "releaseTableSeatToBalance" : "delete_zero_amount_lock";
          finding.repairResult = "failed";
          finding.meta.repairError = e?.message || "unknown";
        }
      }
      findings.push(finding);
    }
  }
  return findings;
}

/** Never allow negative balances — periodic version of validateProductionChecks.js's boot-once check. */
async function checkNegativeBalances() {
  const findings = [];
  const bad = await Wallet.find({ $or: [{ balance: { $lt: 0 } }, { lockedBalance: { $lt: 0 } } ] })
    .select("user balance lockedBalance")
    .limit(100);
  for (const w of bad) {
    findings.push(
      makeFinding({
        check: "negative_wallet_balance",
        severity: "critical",
        playerId: w.user,
        message: `Wallet for user ${w.user} has a negative balance (balance=${w.balance}, locked=${w.lockedBalance})`,
        meta: { balance: w.balance, lockedBalance: w.lockedBalance },
      })
    );
  }
  return findings;
}

async function checkHouseWalletFloor() {
  const findings = [];
  const houseKey = process.env.HOUSE_WALLET_KEY || "house-main";
  const house = await HouseWallet.findOne({ key: houseKey }).select("balance lockedBalance");
  if (!house) {
    findings.push(
      makeFinding({
        check: "house_wallet_missing",
        severity: "critical",
        message: "House wallet document does not exist",
      })
    );
    return findings;
  }
  if (house.balance < 0 || house.lockedBalance < 0) {
    findings.push(
      makeFinding({
        check: "house_wallet_negative",
        severity: "critical",
        message: `House wallet has a negative balance (balance=${house.balance}, locked=${house.lockedBalance})`,
        meta: { balance: house.balance, lockedBalance: house.lockedBalance },
      })
    );
  }
  return findings;
}

/**
 * Delta-based conservation: sum(wallets) + house must only change between
 * sweeps by the net external deposit/withdraw flow in that window — every
 * internal movement (bets, wins, rake, tournament escrow) nets to zero by
 * construction. Avoids needing to know an absolute "total supply" constant.
 */
let _lastSnapshot = null; // { totalAt: Date, total: number }

async function checkGlobalConservation() {
  const findings = [];
  const now = new Date();

  const [walletAgg] = await Wallet.aggregate([
    { $group: { _id: null, total: { $sum: { $add: ["$balance", "$lockedBalance"] } } } },
  ]);
  const houseKey = process.env.HOUSE_WALLET_KEY || "house-main";
  const house = await HouseWallet.findOne({ key: houseKey }).select("balance");
  const currentTotal = (walletAgg?.total || 0) + (house?.balance || 0);

  if (_lastSnapshot) {
    const flowAgg = await WalletTransaction.aggregate([
      {
        $match: {
          type: { $in: ["deposit", "withdraw"] },
          createdAt: { $gt: _lastSnapshot.totalAt, $lte: now },
        },
      },
      {
        $group: {
          _id: null,
          netFlow: {
            $sum: { $cond: [{ $eq: ["$type", "deposit"] }, "$amount", { $multiply: ["$amount", -1] }] },
          },
        },
      },
    ]);
    const netFlow = flowAgg[0]?.netFlow || 0;
    const expectedTotal = _lastSnapshot.total + netFlow;
    const drift = currentTotal - expectedTotal;

    // Small tolerance for in-flight transactions timed right at the sweep boundary.
    if (Math.abs(drift) > 1) {
      findings.push(
        makeFinding({
          check: "global_conservation_drift",
          severity: "critical",
          message: `Economy conservation drift of ${drift} detected between sweeps (coins created/destroyed outside deposit/withdraw)`,
          meta: {
            previousTotal: _lastSnapshot.total,
            currentTotal,
            netExternalFlow: netFlow,
            expectedTotal,
            drift,
            windowStart: _lastSnapshot.totalAt,
            windowEnd: now,
          },
        })
      );
    }
  }

  _lastSnapshot = { totalAt: now, total: currentTotal };
  return findings;
}

async function run(settings) {
  const [orphanLocks, negBalances, houseFloor, conservation] = await Promise.all([
    checkOrphanWalletLocks(settings),
    checkNegativeBalances(),
    checkHouseWalletFloor(),
    checkGlobalConservation(),
  ]);
  return { findings: [...orphanLocks, ...negBalances, ...houseFloor, ...conservation] };
}

module.exports = {
  run,
  checkOrphanWalletLocks,
  checkNegativeBalances,
  checkHouseWalletFloor,
  checkGlobalConservation,
};
