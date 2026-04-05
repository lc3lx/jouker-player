/**
 * Production sanity checks: wallet invariants + optional engine smoke test.
 * Usage: node scripts/validateProductionChecks.js
 * Requires DB_URI / MONGODB_URI in .env (same as main app).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { execSync } = require("child_process");
const path = require("path");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");

const uri = process.env.DB_URI || process.env.MONGODB_URI;
const skipSmoke = String(process.env.SKIP_POKER_SMOKE || "").toLowerCase() === "true";

async function main() {
  if (!uri) {
    console.error("Missing DB_URI or MONGODB_URI — skipping DB checks.");
    process.exit(1);
  }

  await mongoose.connect(uri);

  const badWallet = await Wallet.findOne({
    $or: [{ balance: { $lt: 0 } }, { lockedBalance: { $lt: 0 } }],
  }).lean();
  if (badWallet) {
    console.error("FAIL: wallet with negative balance or lockedBalance", badWallet._id);
    process.exit(1);
  }

  const dupAgg = await WalletTransaction.aggregate([
    {
      $group: {
        _id: {
          userId: "$userId",
          type: "$type",
          amount: "$amount",
          createdAt: "$createdAt",
          balanceAfter: "$balanceAfter",
          lockedBalanceAfter: "$lockedBalanceAfter",
        },
        c: { $sum: 1 },
      },
    },
    { $match: { c: { $gt: 1 } } },
    { $limit: 5 },
  ]);
  if (dupAgg.length > 0) {
    console.warn("WARN: possible duplicate ledger rows (same user/type/amount/time):", dupAgg);
  }

  if (!skipSmoke) {
    const smoke = path.join(__dirname, "..", "tests", "poker_engine_smoke.test.js");
    try {
      execSync(`node "${smoke}"`, { stdio: "inherit" });
    } catch {
      console.error("FAIL: poker_engine_smoke.test.js");
      process.exit(1);
    }
  }

  console.log("validateProductionChecks: OK");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
