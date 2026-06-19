const HouseWallet = require("../models/houseWalletModel");
const HouseWalletTransaction = require("../models/houseWalletTransactionModel");

const HOUSE_WALLET_KEY = process.env.HOUSE_WALLET_KEY || "house-main";

function toSafeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function sessionOptions(session) {
  return session ? { session } : undefined;
}

function withOptionalSession(query, session) {
  return session ? query.session(session) : query;
}

async function getHouseWallet({ session, createIfMissing = false } = {}) {
  let wallet = await withOptionalSession(HouseWallet.findOne({ key: HOUSE_WALLET_KEY }), session);
  if (!wallet && createIfMissing) {
    [wallet] = await HouseWallet.create(
      [{ key: HOUSE_WALLET_KEY, balance: 0, lockedBalance: 0 }],
      sessionOptions(session)
    );
  }
  return wallet;
}

async function ensureHouseWalletExists({ session, createIfMissing = false } = {}) {
  const wallet = await getHouseWallet({ session, createIfMissing });
  if (!wallet) throw new Error("HOUSE_WALLET_MISSING");
  return wallet;
}

async function appendHouseLedger({
  session,
  type,
  amount,
  walletBefore,
  walletAfter,
  tableId = null,
  handId = null,
  settlementId = null,
  meta = {},
}) {
  const [created] = await HouseWalletTransaction.create(
    [
      {
        houseKey: HOUSE_WALLET_KEY,
        type,
        amount: toSafeInt(amount, 0),
        balanceBefore: toSafeInt(walletBefore.balance, 0),
        balanceAfter: toSafeInt(walletAfter.balance, 0),
        lockedBalanceBefore: toSafeInt(walletBefore.lockedBalance, 0),
        lockedBalanceAfter: toSafeInt(walletAfter.lockedBalance, 0),
        tableId: tableId || undefined,
        handId: handId || undefined,
        settlementId: settlementId || undefined,
        meta,
      },
    ],
    sessionOptions(session)
  );
  return created;
}

/**
 * Positive delta credits house, negative delta debits house.
 */
async function applyHouseDelta({
  session,
  delta,
  type = "house_settlement",
  tableId = null,
  handId = null,
  settlementId = null,
  meta = {},
}) {
  const d = toSafeInt(delta, 0);
  if (d === 0) return null;

  const wallet = await ensureHouseWalletExists({
    session,
    createIfMissing: process.env.NODE_ENV !== "production",
  });
  const before = {
    balance: toSafeInt(wallet.balance, 0),
    lockedBalance: toSafeInt(wallet.lockedBalance, 0),
  };
  const nextBalance = before.balance + d;
  if (nextBalance < 0) {
    throw new Error("HOUSE_WALLET_INSUFFICIENT_BALANCE");
  }
  wallet.balance = nextBalance;
  await wallet.save(sessionOptions(session));

  const txType = d >= 0 ? type : type;
  await appendHouseLedger({
    session,
    type: txType,
    amount: Math.abs(d),
    walletBefore: before,
    walletAfter: {
      balance: toSafeInt(wallet.balance, 0),
      lockedBalance: toSafeInt(wallet.lockedBalance, 0),
    },
    tableId,
    handId,
    settlementId,
    meta: { ...meta, direction: d >= 0 ? "credit" : "debit" },
  });
  return wallet;
}

module.exports = {
  HOUSE_WALLET_KEY,
  getHouseWallet,
  ensureHouseWalletExists,
  applyHouseDelta,
};
