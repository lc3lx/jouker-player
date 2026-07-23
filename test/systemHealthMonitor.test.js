"use strict";

/**
 * Integration tests for the production monitoring/self-healing layer
 * (services/monitoring/*, services/systemHealthMonitorService.js). Seeds a
 * real instance of each anomaly class against a real MongoDB replica set
 * (same MongoMemoryReplSet pattern as poker.gameplay-e2e.test.js) and
 * verifies detection + the auto-repairs that touch real money/state.
 */
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Table = require("../models/tableModel");
const Wallet = require("../models/walletModel");
const WalletTableLock = require("../models/walletTableLockModel");
const HouseWallet = require("../models/houseWalletModel");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

const tableHealthChecks = require("../services/monitoring/tableHealthChecks");
const economyHealthChecks = require("../services/monitoring/economyHealthChecks");
const timerManager = require("../engine/TimerManager");
const roomManager = require("../rooms/roomManager");

let replSet = null;
const savedEnv = {};
let tableSeq = 9000;

test.before(async () => {
  for (const k of ["MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE"]) savedEnv[k] = process.env[k];
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(replSet.getUri(), { dbName: "system_health_monitor" });
  await HouseWallet.create({ key: process.env.HOUSE_WALLET_KEY || "house-main", balance: 1_000_000_000, lockedBalance: 0 });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("checkDuplicateSeats flags a user present twice across seats/vacatingPlayers/waitingQueue", async () => {
  tableSeq += 1;
  const uid = new mongoose.Types.ObjectId();
  const otherUid = new mongoose.Types.ObjectId();
  const table = await Table.create({
    gameType: "trix",
    tier: "beginner",
    tableNumber: tableSeq,
    tableKind: "dynamic",
    smallBlind: 0,
    bigBlind: 0,
    minBuyIn: 1000,
    maxBuyIn: 1000,
    capacity: 4,
    status: "open",
    seats: [
      { user: uid, chips: 1000 },
      { user: otherUid, chips: 1000 },
    ],
    waitingQueue: [{ user: uid, buyIn: 1000 }],
  });

  const findings = await tableHealthChecks.checkDuplicateSeats();
  const hit = findings.find((f) => f.tableId === String(table._id));
  assert.ok(hit, "duplicate seat/queue overlap must be detected");
  assert.equal(hit.severity, "critical");
  assert.equal(hit.meta.duplicateUsers.includes(String(uid)), true);
});

test("checkOrphanWalletLocks auto-repairs a funded lock with no matching seat/vacating/queue", async () => {
  tableSeq += 1;
  const uid = new mongoose.Types.ObjectId();
  const table = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableSeq,
    tableKind: "dynamic",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    seats: [], // no seat for uid — the lock below is orphaned
  });

  await Wallet.create({ user: uid, balance: 0, lockedBalance: 5000 });
  const lock = await WalletTableLock.create({ user: uid, table: table._id, amount: 5000 });
  // Backdate updatedAt past the grace window without touching the app's
  // normal save path (raw collection update bypasses Mongoose timestamps).
  await WalletTableLock.collection.updateOne(
    { _id: lock._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
  );

  const findings = await economyHealthChecks.checkOrphanWalletLocks({
    walletLockOrphanGraceMs: 5 * 60 * 1000,
    autoRepairEnabled: true,
  });
  const hit = findings.find((f) => f.tableId === String(table._id) && f.playerId === String(uid));
  assert.ok(hit, "orphaned funded lock must be detected");
  assert.equal(hit.severity, "critical");
  assert.equal(hit.repaired, true);
  assert.equal(hit.repairAction, "releaseTableSeatToBalance");

  const wallet = await Wallet.findOne({ user: uid });
  assert.equal(wallet.lockedBalance, 0, "orphaned lock must be released from lockedBalance");
  assert.equal(wallet.balance, 5000, "released funds must land in spendable balance");

  const lockAfter = await WalletTableLock.findById(lock._id);
  assert.equal(lockAfter.amount, 0, "the lock's own amount must be zeroed out");
});

test("checkOrphanWalletLocks deletes a zero-amount orphaned lock without touching the wallet", async () => {
  tableSeq += 1;
  const uid = new mongoose.Types.ObjectId();
  const table = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableSeq,
    tableKind: "dynamic",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    seats: [],
  });
  await Wallet.create({ user: uid, balance: 1000, lockedBalance: 0 });
  const lock = await WalletTableLock.create({ user: uid, table: table._id, amount: 0 });
  await WalletTableLock.collection.updateOne(
    { _id: lock._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
  );

  const findings = await economyHealthChecks.checkOrphanWalletLocks({
    walletLockOrphanGraceMs: 5 * 60 * 1000,
    autoRepairEnabled: true,
  });
  const hit = findings.find((f) => f.tableId === String(table._id) && f.playerId === String(uid));
  assert.ok(hit);
  assert.equal(hit.severity, "warning");
  assert.equal(hit.repaired, true);
  assert.equal(hit.repairAction, "delete_zero_amount_lock");

  const lockAfter = await WalletTableLock.findById(lock._id);
  assert.equal(lockAfter, null, "zero-amount orphan lock row must be deleted");
  const wallet = await Wallet.findOne({ user: uid });
  assert.equal(wallet.balance, 1000, "wallet balance must be untouched");
});

test("checkOrphanWalletLocks does NOT flag a lock still attributed to a live seat", async () => {
  tableSeq += 1;
  const uid = new mongoose.Types.ObjectId();
  const table = await Table.create({
    gameType: "poker",
    tier: "beginner",
    tableNumber: tableSeq,
    tableKind: "dynamic",
    smallBlind: 50,
    bigBlind: 100,
    minBuyIn: 10000,
    maxBuyIn: 10000,
    capacity: 9,
    status: "waiting",
    seats: [{ user: uid, chips: 5000, seatPosition: 0 }],
  });
  await Wallet.create({ user: uid, balance: 0, lockedBalance: 5000 });
  const lock = await WalletTableLock.create({ user: uid, table: table._id, amount: 5000 });
  await WalletTableLock.collection.updateOne(
    { _id: lock._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }
  );

  const findings = await economyHealthChecks.checkOrphanWalletLocks({
    walletLockOrphanGraceMs: 5 * 60 * 1000,
    autoRepairEnabled: true,
  });
  const hit = findings.find((f) => f.tableId === String(table._id) && f.playerId === String(uid));
  assert.equal(hit, undefined, "a lock matching a live seat must never be flagged");

  const wallet = await Wallet.findOne({ user: uid });
  assert.equal(wallet.lockedBalance, 5000, "legitimate lock must be untouched");
});

test("checkOrphanTimerNamespaces clears a TimerManager namespace with no live game", async () => {
  const orphanRoomId = "trix_table_ghost_no_live_game";
  timerManager.schedule(orphanRoomId, "turn", 999999, () => {});
  assert.ok(timerManager.sizeForNamespace(orphanRoomId) > 0);
  assert.equal(roomManager.trixGamesByTableId.has("ghost_no_live_game"), false);

  const findings = await tableHealthChecks.checkOrphanTimerNamespaces({ autoRepairEnabled: true });
  const hit = findings.find((f) => f.meta.namespace === orphanRoomId);
  assert.ok(hit, "orphaned namespace must be detected");
  assert.equal(hit.repaired, true);
  assert.equal(hit.repairAction, "timerManager.clearAll");
  assert.equal(timerManager.sizeForNamespace(orphanRoomId), 0, "orphaned timers must be cleared");
});

test("checkNegativeBalances flags a wallet with a negative locked balance", async () => {
  const uid = new mongoose.Types.ObjectId();
  // The Wallet schema's own min:0 validator makes this unreachable through
  // any normal .save() — simulate the only realistic way it could appear
  // (raw data corruption / an external bug bypassing the model) via a raw
  // driver insert that skips Mongoose validation.
  await Wallet.collection.insertOne({ user: uid, balance: 100, lockedBalance: -50 });

  const findings = await economyHealthChecks.checkNegativeBalances();
  const hit = findings.find((f) => f.playerId === String(uid));
  assert.ok(hit, "negative lockedBalance must be flagged");
  assert.equal(hit.severity, "critical");
});

test("checkGlobalConservation: first call only snapshots (no baseline yet), second call passes when flow is accounted for, flags real drift", async () => {
  const WalletTransaction = require("../models/walletTransactionModel");

  // First call establishes the baseline snapshot — must not false-positive.
  const first = await economyHealthChecks.checkGlobalConservation();
  assert.deepEqual(first, []);

  // A legitimate external deposit between sweeps must NOT trip the check.
  const uid = new mongoose.Types.ObjectId();
  await Wallet.create({ user: uid, balance: 2000, lockedBalance: 0 });
  await WalletTransaction.create({
    userId: uid,
    type: "deposit",
    amount: 2000,
    balanceBefore: 0,
    balanceAfter: 2000,
    lockedBalanceBefore: 0,
    lockedBalanceAfter: 0,
  });
  const second = await economyHealthChecks.checkGlobalConservation();
  assert.deepEqual(second, [], "an accounted-for deposit must not be flagged as drift");

  // Now mutate a wallet directly (bypassing the ledger entirely) to simulate
  // real drift — coins appearing with no corresponding deposit transaction.
  await Wallet.updateOne({ user: uid }, { $set: { balance: 5000 } });
  const third = await economyHealthChecks.checkGlobalConservation();
  const hit = third.find((f) => f.check === "global_conservation_drift");
  assert.ok(hit, "unaccounted-for balance change must be flagged as drift");
  assert.equal(hit.meta.drift, 3000);
});

test("systemHealthMonitorService.runSweepOnce completes and produces a valid snapshot", async () => {
  const systemHealthMonitorService = require("../services/systemHealthMonitorService");
  const snapshot = await systemHealthMonitorService.runSweepOnce();

  assert.ok(snapshot.at);
  assert.equal(typeof snapshot.overallScore, "number");
  assert.ok(snapshot.overallScore >= 0 && snapshot.overallScore <= 100);
  for (const name of ["tables", "economy", "tournaments", "sockets", "process"]) {
    assert.ok(snapshot.subsystems[name], `subsystem "${name}" must report`);
    assert.ok(["healthy", "warning", "critical"].includes(snapshot.subsystems[name].status));
  }
  assert.equal(systemHealthMonitorService.getSnapshot(), snapshot);
});
