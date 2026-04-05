const mongoose = require("mongoose");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const logger = require("../utils/logger");
const { metrics } = require("../utils/metrics");
const { sendAlert } = require("../utils/alert");

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
  await WalletTransaction.create([txPayload], sessionOptions(session));
  logger.info("wallet_transaction", txPayload);
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
  }
}

async function withMongoTransaction(work) {
  const allowFallback =
    String(process.env.ALLOW_NON_TRANSACTION_FALLBACK || "").toLowerCase() === "true" ||
    process.env.NODE_ENV !== "production";
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    metrics.errorsTotal.inc({ type: "wallet_txn_failed" });
    logger.error("wallet_txn_failed", { reason: err?.message || "unknown" });
    if (allowFallback && isTransactionUnsupportedError(err)) {
      logger.warn("wallet_txn_fallback_non_atomic", {
        reason: err?.message || "unknown",
        mode: "standalone_mongo",
      });
      // Dev/standalone compatibility path: same business logic, no Mongo transaction.
      return work(null);
    }
    throw err;
  } finally {
    await session.endSession();
  }
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
  getOrCreateWallet,
  transferToLocked,
  transferToBalance,
  applyLockedDelta,
  ledgerDeposit,
  ledgerWithdraw,
  appendBalancesUnchanged,
};

