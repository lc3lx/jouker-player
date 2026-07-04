/**
 * Production sanity checks: economy and security guardrails.
 * Usage: node scripts/validateProductionChecks.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { execSync } = require("child_process");
const path = require("path");
const Wallet = require("../models/walletModel");
const WalletTransaction = require("../models/walletTransactionModel");
const { getHouseWallet } = require("../services/houseWalletService");
const {
  buildSettlementPlan,
  validateReconciliation,
} = require("../services/gameSettlementService");

function parseCorsOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// Use the canonical isProduction() that reads APP_MODE, so both
// startup checks and runtime fraud-strictness use the same definition.
const { isProduction } = require("../utils/appConfig");

async function assertReplicaSetEnabled() {
  const admin = mongoose.connection.db.admin();
  const hello = await admin.command({ hello: 1 });
  const isReplica = !!hello.setName || hello.msg === "isdbgrid";
  if (!isReplica) {
    throw new Error("PRODUCTION_REQUIRES_REPLICA_SET");
  }
}

function assertJwtSecret() {
  if (!process.env.JWT_SECRET_KEY) {
    throw new Error("JWT_SECRET_KEY_MISSING");
  }
}

function assertCorsWhitelist() {
  const origins = parseCorsOrigins(process.env.CORS_ORIGINS);
  if (origins.length === 0) {
    throw new Error("CORS_ORIGINS_MISSING");
  }
  if (origins.includes("*")) {
    throw new Error("CORS_WILDCARD_FORBIDDEN_IN_PRODUCTION");
  }
}

function assertTransactionFallbackDisabled() {
  const fallback =
    String(process.env.ALLOW_NON_TRANSACTION_FALLBACK || "").toLowerCase() === "true";
  if (fallback) {
    throw new Error("ALLOW_NON_TRANSACTION_FALLBACK_FORBIDDEN_IN_PRODUCTION");
  }
}

async function assertHouseWalletExists() {
  const wallet = await getHouseWallet();
  if (!wallet) {
    throw new Error("HOUSE_WALLET_MISSING");
  }
  if (Number(wallet.balance || 0) < 0) {
    throw new Error("HOUSE_WALLET_NEGATIVE_BALANCE");
  }
}

function assertSettlementEngineHealth() {
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [100, 50, 20, 10] },
    participants: [
      { userId: new mongoose.Types.ObjectId(), seatIndex: 0, buyIn: 1000, isBot: false },
      { userId: new mongoose.Types.ObjectId(), seatIndex: 1, buyIn: 1000, isBot: false },
      { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
      { userId: null, seatIndex: 3, buyIn: 1000, isBot: true },
    ],
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  if (!recon.balanced) {
    throw new Error(`SETTLEMENT_ENGINE_UNBALANCED:${recon.delta}`);
  }
}

async function assertWalletInvariants() {
  const badWallet = await Wallet.findOne({
    $or: [{ balance: { $lt: 0 } }, { lockedBalance: { $lt: 0 } }],
  }).lean();
  if (badWallet) {
    throw new Error(`NEGATIVE_WALLET:${badWallet._id}`);
  }
}

async function warnDuplicateLedgerRows() {
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
    // soft warning only; does not block startup
    console.warn("WARN: possible duplicate ledger rows:", dupAgg);
  }
}

function runSmokeIfRequested() {
  const skipSmoke = String(process.env.SKIP_POKER_SMOKE || "").toLowerCase() === "true";
  if (skipSmoke) return;
  const smoke = path.join(__dirname, "..", "tests", "poker_engine_smoke.test.js");
  execSync(`node "${smoke}"`, { stdio: "inherit" });
}

async function runProductionChecks({ skipSmoke = false } = {}) {
  const uri = process.env.DB_URI || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI_MISSING");

  const alreadyConnected = mongoose.connection.readyState === 1;
  if (!alreadyConnected) {
    await mongoose.connect(uri);
  }

  try {
    if (isProduction()) {
      assertJwtSecret();
      assertCorsWhitelist();
      assertTransactionFallbackDisabled();
      await assertReplicaSetEnabled();
      await assertHouseWalletExists();
    }
    assertSettlementEngineHealth();
    await assertWalletInvariants();
    await warnDuplicateLedgerRows();
    if (!skipSmoke) runSmokeIfRequested();
    return { ok: true };
  } finally {
    if (!alreadyConnected) {
      await mongoose.disconnect();
    }
  }
}

async function main() {
  await runProductionChecks();
  console.log("validateProductionChecks: OK");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("validateProductionChecks: FAIL", e?.message || e);
    process.exit(1);
  });
}

module.exports = { runProductionChecks };
