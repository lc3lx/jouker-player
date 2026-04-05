/* eslint-disable no-console */
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const dbConnection = require("../config/database");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");

dotenv.config();

async function reconcileUser(userId) {
  const wallet = await Wallet.findOne({ user: userId });
  if (!wallet) return null;

  const txs = await WalletTransaction.find({ userId }).sort({ createdAt: 1, _id: 1 });

  let balance = 0;
  let locked = 0;
  for (const tx of txs) {
    const amt = Number(tx.amount || 0);
    switch (tx.type) {
      case "transfer_to_locked":
        balance -= amt;
        locked += amt;
        break;
      case "transfer_to_balance":
        locked -= amt;
        balance += amt;
        break;
      case "bet":
      case "rake":
        locked -= amt;
        break;
      case "win":
      case "refund":
        locked += amt;
        break;
      default:
        break;
    }
  }

  return {
    userId: String(userId),
    walletBalance: Number(wallet.balance || 0),
    walletLocked: Number(wallet.lockedBalance || 0),
    recomputedBalance: balance,
    recomputedLocked: locked,
    ok: balance === Number(wallet.balance || 0) && locked === Number(wallet.lockedBalance || 0),
  };
}

async function main() {
  await dbConnection();

  const wallets = await Wallet.find({}, { user: 1 });
  let mismatches = 0;
  for (const w of wallets) {
    const report = await reconcileUser(w.user);
    if (!report) continue;
    if (!report.ok) {
      mismatches += 1;
      console.log("[MISMATCH]", report);
    }
  }

  console.log(`Reconciliation finished. Wallets=${wallets.length}, mismatches=${mismatches}`);
  await mongoose.connection.close();
}

main().catch(async (e) => {
  console.error("Reconciliation failed:", e);
  try {
    await mongoose.connection.close();
  } catch (_) {}
  process.exit(1);
});

