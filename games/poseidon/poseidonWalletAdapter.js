/**
 * Wallet integration layer — decoupled from game math.
 *
 * Modes:
 *   stub (default) — in-memory balances for local dev / unit tests
 *   mongo          — uses existing Wallet model + ledger transactions
 *
 * All monetary ops run inside per-user mutex to prevent double-spend races.
 * Same contract as games/goldenTree/goldenTreeWalletAdapter.js.
 */

const crypto = require("crypto");
const { roundMoney } = require("./constants");

const MODE =
  process.env.POSEIDON_WALLET_MODE ||
  (process.env.NODE_ENV === "test" ? "stub" : "mongo");

/** @type {Map<string, { balance: number, version: number }>} */
const stubBalances = new Map();

/** @type {Map<string, Promise<void>>} */
const userLocks = new Map();

async function withUserLock(userId, fn) {
  const key = String(userId);
  const prev = userLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(key, prev.then(() => gate));

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === gate) {
      userLocks.delete(key);
    }
  }
}

function ensureStubUser(userId) {
  const key = String(userId);
  if (!stubBalances.has(key)) {
    stubBalances.set(key, { balance: 50000000, version: 0 });
  }
  return stubBalances.get(key);
}

async function getBalanceStub(userId) {
  return roundMoney(ensureStubUser(userId).balance);
}

async function deductBalanceStub(userId, amount, meta = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) throw new Error("INVALID_DEDUCT_AMOUNT");
  const row = ensureStubUser(userId);
  if (row.balance < amt) {
    const err = new Error("INSUFFICIENT_BALANCE");
    err.code = "INSUFFICIENT_BALANCE";
    throw err;
  }
  row.balance = roundMoney(row.balance - amt);
  row.version += 1;
  return {
    balance: row.balance,
    transactionId: crypto.randomUUID(),
    meta,
  };
}

async function creditBalanceStub(userId, amount, meta = {}) {
  const amt = roundMoney(amount);
  if (amt <= 0) return { balance: ensureStubUser(userId).balance, skipped: true };
  const row = ensureStubUser(userId);
  row.balance = roundMoney(row.balance + amt);
  row.version += 1;
  return {
    balance: row.balance,
    transactionId: crypto.randomUUID(),
    meta,
  };
}

async function getBalanceMongo(userId) {
  const Wallet = require("../../models/walletModel");
  let wallet = await Wallet.findOne({ user: userId });
  if (!wallet) wallet = await Wallet.create({ user: userId });
  return roundMoney(Number(wallet.balance) || 0);
}

async function deductBalanceMongo(userId, amount, meta = {}) {
  const { withMongoTransaction, ledgerWithdraw } = require("../../services/walletLedgerService");
  const amt = roundMoney(amount);
  if (amt <= 0) throw new Error("INVALID_DEDUCT_AMOUNT");

  let balanceAfter = 0;
  await withMongoTransaction(async (session) => {
    await ledgerWithdraw({
      session,
      userId,
      amount: Math.round(amt),
      ledgerType: "game_loss",
      meta: { source: "poseidon", ...meta },
    });
    balanceAfter = await getBalanceMongo(userId);
  });
  return { balance: balanceAfter, transactionId: crypto.randomUUID(), meta };
}

async function creditBalanceMongo(userId, amount, meta = {}) {
  const { withMongoTransaction, ledgerDeposit } = require("../../services/walletLedgerService");
  const amt = roundMoney(amount);
  if (amt <= 0) return { balance: await getBalanceMongo(userId), skipped: true };

  let balanceAfter = 0;
  await withMongoTransaction(async (session) => {
    await ledgerDeposit({
      session,
      userId,
      amount: Math.round(amt),
      ledgerType: "game_win",
      meta: { source: "poseidon", ...meta },
    });
    balanceAfter = await getBalanceMongo(userId);
  });
  return { balance: balanceAfter, transactionId: crypto.randomUUID(), meta };
}

async function getBalance(userId) {
  if (MODE === "mongo") return getBalanceMongo(userId);
  return getBalanceStub(userId);
}

async function deductBalance(userId, amount, meta = {}) {
  return withUserLock(userId, () => {
    if (MODE === "mongo") return deductBalanceMongo(userId, amount, meta);
    return deductBalanceStub(userId, amount, meta);
  });
}

async function creditBalance(userId, amount, meta = {}) {
  return withUserLock(userId, () => {
    if (MODE === "mongo") return creditBalanceMongo(userId, amount, meta);
    return creditBalanceStub(userId, amount, meta);
  });
}

/**
 * Atomic bet + optional win settlement in one locked transaction.
 */
async function atomicSpinWallet(userId, { betAmount, winAmount, meta = {} }) {
  return withUserLock(userId, async () => {
    const bet = roundMoney(betAmount);
    const win = roundMoney(winAmount);

    if (bet > 0) {
      const currentBalance =
        MODE === "mongo"
          ? await getBalanceMongo(userId)
          : roundMoney(ensureStubUser(userId).balance);
      if (currentBalance < bet) {
        const err = new Error("INSUFFICIENT_BALANCE");
        err.code = "INSUFFICIENT_BALANCE";
        throw err;
      }

      if (MODE === "mongo") {
        await deductBalanceMongo(userId, bet, { ...meta, leg: "bet" });
      } else {
        await deductBalanceStub(userId, bet, { ...meta, leg: "bet" });
      }
    }

    if (win > 0) {
      if (MODE === "mongo") {
        await creditBalanceMongo(userId, win, { ...meta, leg: "win" });
      } else {
        await creditBalanceStub(userId, win, { ...meta, leg: "win" });
      }
    }

    return getBalance(userId);
  });
}

function seedStubBalance(userId, balance) {
  stubBalances.set(String(userId), { balance: roundMoney(balance), version: 0 });
}

function clearStubForTests() {
  stubBalances.clear();
  userLocks.clear();
}

module.exports = {
  MODE,
  getBalance,
  deductBalance,
  creditBalance,
  atomicSpinWallet,
  withUserLock,
  seedStubBalance,
  clearStubForTests,
};
