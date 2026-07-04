const mongoose = require("mongoose");
const Wallet = require("../models/walletModel");
const WalletTableLock = require("../models/walletTableLockModel");
const WalletTransaction = require("../models/walletTransactionModel");
const logger = require("../utils/logger");
const { metrics } = require("../utils/metrics");
const { sendAlert } = require("../utils/alert");
const { recordActivityFromTransaction } = require("./activityService");
const { applyHouseDelta, ensureHouseWalletExists } = require("./houseWalletService");

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function withOptionalSession(query, session) {
  return session ? query.session(session) : query;
}

function sessionOptions(session) {
  return session ? { session } : undefined;
}

function isTransactionUnsupportedError(err) {
  const msg = String(err?.message || "");
  return msg.includes("Transaction numbers are only allowed on a replica set member or mongos");
}

/** @type {"unknown" | "supported" | "unsupported"} */
let _mongoTxnCapability = "unknown";
let _mongoTxnProbePromise = null;

function allowNonTransactionFallback() {
  return (
    process.env.NODE_ENV !== "production" &&
    String(process.env.ALLOW_NON_TRANSACTION_FALLBACK || "true").toLowerCase() !==
      "false"
  );
}

function isLikelyStandaloneMongoUri() {
  const uri =
    process.env.DB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/game";
  if (/replicaSet=/i.test(uri)) return false;
  if (/mongos/i.test(uri)) return false;
  return /localhost|127\.0\.0\.1/i.test(uri);
}

/**
 * Probe once whether this Mongo deployment supports multi-document transactions.
 * Standalone dev instances do not; replica sets and mongos do.
 */
async function probeMongoTransactions() {
  if (_mongoTxnCapability !== "unknown") return _mongoTxnCapability;
  if (!_mongoTxnProbePromise) {
    _mongoTxnProbePromise = _runMongoTransactionProbe();
  }
  return _mongoTxnProbePromise;
}

async function _runMongoTransactionProbe() {
  if (
    allowNonTransactionFallback() &&
    (String(process.env.MONGO_STANDALONE || "").toLowerCase() === "true" ||
      isLikelyStandaloneMongoUri())
  ) {
    _mongoTxnCapability = "unsupported";
    logger.info("mongo_standalone_mode", {
      mode: "non_transaction_wallet",
      hint: "Wallet ops run without Mongo transactions on local dev. Use a replica set in production.",
    });
    return _mongoTxnCapability;
  }

  const session = await mongoose.startSession();
  try {
    // Empty callbacks can falsely pass on standalone; touch the DB inside the txn.
    await session.withTransaction(async () => {
      await withOptionalSession(Wallet.findOne({ _id: new mongoose.Types.ObjectId() }), session)
        .lean();
    });
    _mongoTxnCapability = "supported";
    return _mongoTxnCapability;
  } catch (err) {
    if (isTransactionUnsupportedError(err)) {
      _mongoTxnCapability = "unsupported";
      if (allowNonTransactionFallback()) {
        logger.info("mongo_standalone_mode", {
          reason: err?.message || "unknown",
          mode: "non_transaction_wallet",
        });
      } else {
        logger.error("mongo_transactions_required", {
          reason: err?.message || "unknown",
          hint: "Production requires MongoDB replica set or mongos.",
        });
      }
      return _mongoTxnCapability;
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/** Test helper: reset cached probe result. */
function resetMongoTransactionProbeForTests() {
  _mongoTxnCapability = "unknown";
  _mongoTxnProbePromise = null;
}

async function getOrCreateTableLock(userId, tableId, session) {
  let row = await withOptionalSession(
    WalletTableLock.findOne({ user: userId, table: tableId }),
    session
  );
  if (!row) {
    [row] = await WalletTableLock.create(
      [{ user: userId, table: tableId, amount: 0 }],
      sessionOptions(session)
    );
  }
  return row;
}

async function getTableLockAmount(userId, tableId, session) {
  const row = await withOptionalSession(
    WalletTableLock.findOne({ user: userId, table: tableId }),
    session
  );
  return row ? toSafeInt(row.amount, 0) : 0;
}

async function addTableLock({ session, userId, tableId, amount }) {
  const amt = toSafeInt(amount, 0);
  if (amt <= 0 || !tableId) return;
  const row = await getOrCreateTableLock(userId, tableId, session);
  row.amount = toSafeInt(row.amount, 0) + amt;
  await row.save(sessionOptions(session));
}

async function adjustTableLock({ session, userId, tableId, delta }) {
  const d = toSafeInt(delta, 0);
  if (d === 0 || !tableId) return;
  const row = await getOrCreateTableLock(userId, tableId, session);
  const next = toSafeInt(row.amount, 0) + d;
  if (next < 0) {
    // Table-lock rows can drift from global lockedBalance on standalone Mongo;
    // clamp instead of aborting hand settlement (global lock already adjusted).
    const payload = { userId: String(userId), tableId: String(tableId), before: toSafeInt(row.amount, 0), delta: d };
    logger.warn("table_lock_underflow_clamped", payload);
    if (process.env.NODE_ENV === "production") {
      void sendAlert("table_lock_underflow", payload);
    }
    row.amount = 0;
    await row.save(sessionOptions(session));
    return;
  }
  row.amount = next;
  await row.save(sessionOptions(session));
}

async function applyTableLockSpend({ session, userId, tableId, spend }) {
  const amt = toSafeInt(spend, 0);
  if (amt <= 0 || !tableId) return;
  const row = await getOrCreateTableLock(userId, tableId, session);
  const tableLocked = toSafeInt(row.amount, 0);
  const tableSpend = Math.min(amt, tableLocked);
  if (tableSpend > 0) {
    await adjustTableLock({ session, userId, tableId, delta: -tableSpend });
  }
}

async function setTableLockAmount({ session, userId, tableId, amount }) {
  if (!tableId) return;
  const row = await getOrCreateTableLock(userId, tableId, session);
  row.amount = Math.max(0, toSafeInt(amount, 0));
  await row.save(sessionOptions(session));
}

/**
 * Cash out seat chips scoped to this table's locked attribution — never drains other tables.
 */
async function releaseTableSeatToBalance({
  session,
  userId,
  tableId,
  seatChips,
  handId = null,
  meta = {},
}) {
  const seatAmt = toSafeInt(seatChips, 0);
  if (seatAmt <= 0 || !tableId) return;

  const row = await getOrCreateTableLock(userId, tableId, session);
  const wallet = await getOrCreateWallet(userId, session);
  let tableLocked = toSafeInt(row.amount, 0);
  const globalLocked = toSafeInt(wallet.lockedBalance, 0);

  if (tableLocked < seatAmt) {
    const allLocks = await withOptionalSession(WalletTableLock.find({ user: userId }), session);
    const otherLocked = allLocks.reduce(
      (sum, l) => (String(l.table) !== String(tableId) ? sum + toSafeInt(l.amount, 0) : sum),
      0
    );
    const unattributed = Math.max(0, globalLocked - otherLocked - tableLocked);
    const extra = Math.min(seatAmt - tableLocked, unattributed);
    if (extra > 0) {
      tableLocked += extra;
      row.amount = tableLocked;
      await row.save(sessionOptions(session));
    }
  }

  // Use globalLocked (not tableLocked) so player is made whole even when table
  // attribution has drifted. Money IS in global lock; it's just not attributed correctly.
  const toRelease = Math.min(seatAmt, globalLocked);
  if (toRelease <= 0) {
    throw new Error("INSUFFICIENT_TABLE_LOCKED_BALANCE");
  }

  const attributionShortfall = seatAmt - Math.min(seatAmt, tableLocked);
  if (attributionShortfall > 0) {
    const shortfallPayload = { userId: String(userId), tableId: String(tableId), seatAmt, tableLocked, globalLocked, shortfall: attributionShortfall };
    logger.warn("table_seat_release_attribution_shortfall", shortfallPayload);
    if (process.env.NODE_ENV === "production") {
      void sendAlert("table_seat_release_attribution_shortfall", shortfallPayload);
    }
    row.amount = 0;
  } else {
    row.amount = tableLocked - toRelease;
  }
  await row.save(sessionOptions(session));

  await transferToBalance({
    session,
    userId,
    amount: toRelease,
    tableId,
    handId,
    meta: { ...meta, tableScoped: true, requested: seatAmt, released: toRelease },
  });
}

/**
 * Forfeit table-locked chips when a vacated seat is taken by a bot (no balance credit).
 */
async function forfeitTableSeatLock({
  session,
  userId,
  tableId,
  seatChips,
  meta = {},
}) {
  const seatAmt = toSafeInt(seatChips, 0);
  if (seatAmt <= 0 || !tableId) return 0;

  const row = await getOrCreateTableLock(userId, tableId, session);
  const wallet = await getOrCreateWallet(userId, session);
  let tableLocked = toSafeInt(row.amount, 0);
  const globalLocked = toSafeInt(wallet.lockedBalance, 0);

  const toForfeit = Math.min(seatAmt, tableLocked, globalLocked);
  if (toForfeit <= 0) return 0;

  row.amount = Math.max(0, tableLocked - toForfeit);
  await row.save(sessionOptions(session));

  const beforeBal = toSafeInt(wallet.balance, 0);
  wallet.lockedBalance = Math.max(0, globalLocked - toForfeit);
  await wallet.save(sessionOptions(session));

  await appendWalletTransaction({
    session,
    userId,
    type: "game_loss",
    amount: toForfeit,
    tableId,
    walletBefore: { balance: beforeBal, lockedBalance: globalLocked },
    walletAfter: { balance: beforeBal, lockedBalance: wallet.lockedBalance },
    meta: { ...meta, tableScoped: true, forfeited: toForfeit },
  });

  return toForfeit;
}

async function getOrCreateWallet(userId, session) {
  let wallet = await withOptionalSession(Wallet.findOne({ user: userId }), session);
  if (!wallet) {
    wallet = await Wallet.create([{ user: userId }], sessionOptions(session)).then((rows) => rows[0]);
  }
  return wallet;
}

async function appendWalletTransaction({
  session,
  userId,
  type,
  amount,
  tableId = null,
  handId = null,
  walletBefore,
  walletAfter,
  meta = {},
}) {
  const txPayload = {
    userId,
    type,
    amount: toSafeInt(amount, 0),
    balanceBefore: toSafeInt(walletBefore.balance, 0),
    balanceAfter: toSafeInt(walletAfter.balance, 0),
    lockedBalanceBefore: toSafeInt(walletBefore.lockedBalance, 0),
    lockedBalanceAfter: toSafeInt(walletAfter.lockedBalance, 0),
    tableId: tableId || undefined,
    handId: handId || undefined,
    meta,
  };
  const [created] = await WalletTransaction.create([txPayload], sessionOptions(session));
  logger.info("wallet_transaction", txPayload);
  recordActivityFromTransaction(created?.toObject?.() || created).catch((err) => {
    logger.warn("activity_record_failed", { reason: err?.message || "unknown" });
  });
  return created;
}

/** Ledger row only — wallet balances unchanged (pending / failed payment states). */
async function appendBalancesUnchanged({ session, userId, type, amount, meta = {} }) {
  const wallet = await getOrCreateWallet(userId, session);
  const b = {
    balance: toSafeInt(wallet.balance, 0),
    lockedBalance: toSafeInt(wallet.lockedBalance, 0),
  };
  await appendWalletTransaction({
    session,
    userId,
    type,
    amount: toSafeInt(amount, 0),
    walletBefore: b,
    walletAfter: { ...b },
    meta,
  });
}

async function transferToLocked({ session, userId, amount, tableId, handId = null, meta = {} }) {
  const amt = toSafeInt(amount, 0);
  if (amt <= 0) return;

  const wallet = await getOrCreateWallet(userId, session);
  if (wallet.balance < amt) {
    await sendAlert("wallet_insufficient_balance", {
      userId: String(userId),
      needed: amt,
      balance: wallet.balance,
      context: "transfer_to_locked",
    });
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const before = { balance: wallet.balance, lockedBalance: wallet.lockedBalance || 0 };
  wallet.balance -= amt;
  wallet.lockedBalance = (wallet.lockedBalance || 0) + amt;
  await wallet.save(sessionOptions(session));

  await appendWalletTransaction({
    session,
    userId,
    type: "transfer_to_locked",
    amount: amt,
    tableId,
    handId,
    walletBefore: before,
    walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
    meta,
  });

  if (tableId) {
    await addTableLock({ session, userId, tableId, amount: amt });
  }
}

async function transferToBalance({ session, userId, amount, tableId, handId = null, meta = {} }) {
  const amt = toSafeInt(amount, 0);
  if (amt <= 0) return;

  const wallet = await getOrCreateWallet(userId, session);
  if ((wallet.lockedBalance || 0) < amt) {
    await sendAlert("wallet_locked_transfer_underflow", {
      userId: String(userId),
      needed: amt,
      lockedBalance: wallet.lockedBalance || 0,
      context: "transfer_to_balance",
    });
    throw new Error("INSUFFICIENT_LOCKED_BALANCE");
  }

  const before = { balance: wallet.balance, lockedBalance: wallet.lockedBalance || 0 };
  wallet.lockedBalance -= amt;
  wallet.balance += amt;
  await wallet.save(sessionOptions(session));

  await appendWalletTransaction({
    session,
    userId,
    type: "transfer_to_balance",
    amount: amt,
    tableId,
    handId,
    walletBefore: before,
    walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
    meta,
  });
}

async function applyLockedDelta({
  session,
  userId,
  delta,
  rakeAmount = 0,
  tableId,
  handId,
  meta = {},
}) {
  const d = toSafeInt(delta, 0);
  const rake = toSafeInt(rakeAmount, 0);
  if (d === 0 && rake === 0) return;

  const wallet = await getOrCreateWallet(userId, session);
  wallet.lockedBalance = toSafeInt(wallet.lockedBalance, 0);

  if (d < 0) {
    const spend = Math.abs(d);
    if (wallet.lockedBalance < spend) {
      await sendAlert("wallet_locked_underflow_attempt", {
        userId: String(userId),
        spend,
        lockedBalance: wallet.lockedBalance,
        tableId: tableId ? String(tableId) : null,
        handId: handId || null,
      });
      throw new Error("LOCKED_BALANCE_UNDERFLOW");
    }
    const before = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance -= spend;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "bet",
      amount: spend,
      tableId,
      handId,
      walletBefore: before,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta,
    });
    await applyTableLockSpend({ session, userId, tableId, spend });
    return;
  }

  // d > 0
  const grossWin = d + rake;
  if (grossWin > 0) {
    const beforeWin = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance += grossWin;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "win",
      amount: grossWin,
      tableId,
      handId,
      walletBefore: beforeWin,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta,
    });
    if (tableId) await adjustTableLock({ session, userId, tableId, delta: grossWin });
  }

  if (rake > 0) {
    if (wallet.lockedBalance < rake) {
      await sendAlert("wallet_rake_locked_underflow", {
        userId: String(userId),
        rake,
        lockedBalance: wallet.lockedBalance,
        tableId: tableId ? String(tableId) : null,
        handId: handId || null,
      });
      throw new Error("LOCKED_BALANCE_UNDERFLOW");
    }
    const beforeRake = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance -= rake;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "rake",
      amount: rake,
      tableId,
      handId,
      walletBefore: beforeRake,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta,
    });
    if (tableId) await adjustTableLock({ session, userId, tableId, delta: -rake });
  }
}

async function withMongoTransaction(work) {
  const allowFallback = allowNonTransactionFallback();
  const capability = await probeMongoTransactions();

  if (capability === "unsupported") {
    if (!allowFallback) {
      throw new Error("MONGO_TRANSACTIONS_REQUIRED");
    }
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (allowFallback && isTransactionUnsupportedError(err)) {
      _mongoTxnCapability = "unsupported";
      logger.info("mongo_standalone_mode", {
        reason: err?.message || "unknown",
        mode: "non_transaction_wallet",
        note: "late_detection",
      });
      return work(null);
    }
    metrics.errorsTotal.inc({ type: "wallet_txn_failed" });
    logger.error("wallet_txn_failed", { reason: err?.message || "unknown" });
    throw err;
  } finally {
    await session.endSession();
  }
}

async function applyHouseSettlementDelta({
  session,
  delta,
  tableId,
  handId = null,
  settlementId = null,
  meta = {},
}) {
  return applyHouseDelta({
    session,
    delta,
    type: "house_settlement",
    tableId,
    handId,
    settlementId,
    meta,
  });
}

async function assertHouseWalletReady({ session, createIfMissing = false } = {}) {
  return ensureHouseWalletExists({ session, createIfMissing });
}

async function ledgerDeposit({ session, userId, amount, meta = {}, ledgerType = "deposit" }) {
  const amt = toSafeInt(amount, 0);
  if (amt <= 0) throw new Error("INVALID_AMOUNT");

  const wallet = await getOrCreateWallet(userId, session);
  const before = { balance: toSafeInt(wallet.balance, 0), lockedBalance: toSafeInt(wallet.lockedBalance, 0) };
  wallet.balance = before.balance + amt;
  await wallet.save(sessionOptions(session));

  await appendWalletTransaction({
    session,
    userId,
    type: ledgerType,
    amount: amt,
    walletBefore: before,
    walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance || 0 },
    meta: { ...meta, channel: meta.channel || "simulated" },
  });
  return wallet;
}

/**
 * Game settlement ledger — same locked-balance rules as applyLockedDelta but uses
 * game_win / game_loss / rake transaction types for audit clarity.
 */
async function applyGameSettlementDelta({
  session,
  userId,
  delta,
  rakeAmount = 0,
  tableId,
  settlementId = null,
  meta = {},
}) {
  const d = toSafeInt(delta, 0);
  const rake = toSafeInt(rakeAmount, 0);
  if (d === 0 && rake === 0) return;

  const wallet = await getOrCreateWallet(userId, session);
  wallet.lockedBalance = toSafeInt(wallet.lockedBalance, 0);
  const handId = settlementId || undefined;
  const baseMeta = { ...meta, settlementId: settlementId || undefined };

  if (d < 0) {
    const spend = Math.abs(d);
    if (wallet.lockedBalance < spend) {
      await sendAlert("wallet_locked_underflow_attempt", {
        userId: String(userId),
        spend,
        lockedBalance: wallet.lockedBalance,
        tableId: tableId ? String(tableId) : null,
        settlementId: settlementId || null,
      });
      throw new Error("LOCKED_BALANCE_UNDERFLOW");
    }
    const before = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance -= spend;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "game_loss",
      amount: spend,
      tableId,
      handId,
      walletBefore: before,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta: baseMeta,
    });
    await applyTableLockSpend({ session, userId, tableId, spend });
    return;
  }

  const grossWin = d + rake;
  if (grossWin > 0) {
    const beforeWin = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance += grossWin;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "game_win",
      amount: grossWin,
      tableId,
      handId,
      walletBefore: beforeWin,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta: baseMeta,
    });
    if (tableId) await adjustTableLock({ session, userId, tableId, delta: grossWin });
  }

  if (rake > 0) {
    if (wallet.lockedBalance < rake) {
      await sendAlert("wallet_rake_locked_underflow", {
        userId: String(userId),
        rake,
        lockedBalance: wallet.lockedBalance,
        tableId: tableId ? String(tableId) : null,
        settlementId: settlementId || null,
      });
      throw new Error("LOCKED_BALANCE_UNDERFLOW");
    }
    const beforeRake = { balance: wallet.balance, lockedBalance: wallet.lockedBalance };
    wallet.lockedBalance -= rake;
    await wallet.save(sessionOptions(session));
    await appendWalletTransaction({
      session,
      userId,
      type: "rake",
      amount: rake,
      tableId,
      handId,
      walletBefore: beforeRake,
      walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance },
      meta: baseMeta,
    });
    if (tableId) await adjustTableLock({ session, userId, tableId, delta: -rake });
  }
}

async function recordGameBuyinLedger({ session, userId, amount, tableId, settlementId, meta = {} }) {
  const wallet = await getOrCreateWallet(userId, session);
  const b = {
    balance: toSafeInt(wallet.balance, 0),
    lockedBalance: toSafeInt(wallet.lockedBalance, 0),
  };
  await appendWalletTransaction({
    session,
    userId,
    type: "game_buyin",
    amount: toSafeInt(amount, 0),
    tableId,
    handId: settlementId || undefined,
    walletBefore: b,
    walletAfter: { ...b },
    meta: { ...meta, settlementId },
  });
}

async function recordSettlementLedger({ session, userId, amount, tableId, settlementId, meta = {} }) {
  const wallet = await getOrCreateWallet(userId, session);
  const b = {
    balance: toSafeInt(wallet.balance, 0),
    lockedBalance: toSafeInt(wallet.lockedBalance, 0),
  };
  await appendWalletTransaction({
    session,
    userId,
    type: "settlement",
    amount: toSafeInt(amount, 0),
    tableId,
    handId: settlementId || undefined,
    walletBefore: b,
    walletAfter: { ...b },
    meta: { ...meta, settlementId },
  });
}

async function ledgerWithdraw({ session, userId, amount, meta = {}, ledgerType = "withdraw" }) {
  const amt = toSafeInt(amount, 0);
  if (amt <= 0) throw new Error("INVALID_AMOUNT");

  const wallet = await getOrCreateWallet(userId, session);
  const bal = toSafeInt(wallet.balance, 0);
  if (bal < amt) {
    await sendAlert("wallet_withdraw_underflow", {
      userId: String(userId),
      requested: amt,
      balance: bal,
    });
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const before = { balance: bal, lockedBalance: toSafeInt(wallet.lockedBalance, 0) };
  wallet.balance = bal - amt;
  await wallet.save(sessionOptions(session));

  await appendWalletTransaction({
    session,
    userId,
    type: ledgerType,
    amount: amt,
    walletBefore: before,
    walletAfter: { balance: wallet.balance, lockedBalance: wallet.lockedBalance || 0 },
    meta: { ...meta, channel: meta.channel || "simulated" },
  });
  return wallet;
}

module.exports = {
  withMongoTransaction,
  probeMongoTransactions,
  resetMongoTransactionProbeForTests,
  getOrCreateWallet,
  transferToLocked,
  transferToBalance,
  applyLockedDelta,
  applyGameSettlementDelta,
  recordGameBuyinLedger,
  recordSettlementLedger,
  ledgerDeposit,
  ledgerWithdraw,
  appendBalancesUnchanged,
  getTableLockAmount,
  addTableLock,
  adjustTableLock,
  setTableLockAmount,
  releaseTableSeatToBalance,
  forfeitTableSeatLock,
  applyHouseSettlementDelta,
  assertHouseWalletReady,
};

