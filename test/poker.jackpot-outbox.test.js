"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const HandHistory = require("../models/handHistoryModel");
const Wallet = require("../models/walletModel");
const IslandPool = require("../models/islandPoolModel");
const IslandMember = require("../models/islandMemberModel");
const IslandWinner = require("../models/islandWinnerModel");
const PokerPostSettlementJob = require("../models/pokerPostSettlementJobModel");
const {
  enqueueIslandJackpotJob,
  processPokerPostSettlementJobs,
} = require("../services/pokerPostSettlementJobService");
const { reservePayoutForHand } = require("../services/islandJackpotService");
const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");

let replSet = null;
const savedEnv = {};

test.before(async () => {
  for (const key of ["ISLAND_JACKPOT_ENABLED", "MONGODB_URI", "MONGO_URI", "DB_URI", "MONGO_STANDALONE", "APP_MODE", "REQUIRE_MONGO_TRANSACTIONS", "NODE_ENV"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.ISLAND_JACKPOT_ENABLED = "true";
  process.env.NODE_ENV = "test";
  delete process.env.MONGO_STANDALONE;
  delete process.env.APP_MODE;
  delete process.env.REQUIRE_MONGO_TRANSACTIONS;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  await mongoose.connect(process.env.MONGODB_URI, { dbName: "poker_jackpot_outbox" });
  resetMongoTransactionProbeForTests();
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetMongoTransactionProbeForTests();
});

test("durable jackpot job pays exactly once after a hand commits", async () => {
  const userId = new mongoose.Types.ObjectId();
  const tableId = new mongoose.Types.ObjectId();
  const handId = "outbox-royal-flush";

  await Wallet.create({ user: userId, balance: 0, lockedBalance: 0 });
  await IslandMember.create({ userId, active: true });
  await IslandPool.create({
    key: "default",
    enabled: true,
    poolBalance: 500000,
    minTriggerAmount: 100000,
    payoutPercentages: { royalFlush: 0.8, straightFlush: 0.3, fourOfAKind: 0.2 },
  });
  const hand = await HandHistory.create({ handId, table: tableId, gameType: "poker" });

  await enqueueIslandJackpotJob({
    handId,
    handHistoryId: hand._id,
    tableId,
    payload: {
      handId,
      tableId,
      gameType: "poker",
      reason: "showdown",
      community: ["Qh", "Jh", "Th", "2s", "3s"],
      seats: [
        {
          userId,
          name: "Winner",
          isBot: false,
          folded: false,
          hole: ["Ah", "Kh"],
        },
      ],
    },
  });

  const first = await processPokerPostSettlementJobs();
  assert.equal(first.processed, 1);

  const wallet = await Wallet.findOne({ user: userId }).lean();
  const job = await PokerPostSettlementJob.findOne({ handId }).lean();
  assert.equal(wallet.balance, 400000);
  assert.equal(job.status, "completed");
  assert.equal(await IslandWinner.countDocuments({ handId }), 1);

  await processPokerPostSettlementJobs();
  assert.equal((await Wallet.findOne({ user: userId }).lean()).balance, 400000);
  assert.equal(await IslandWinner.countDocuments({ handId }), 1);
});

test("reserved payout keeps its winners and amount when membership or pool changes later", async () => {
  const userId = new mongoose.Types.ObjectId();
  const tableId = new mongoose.Types.ObjectId();
  const handId = "outbox-frozen-reservation";
  await Wallet.create({ user: userId, balance: 0, lockedBalance: 0 });
  await IslandMember.create({ userId, active: true });
  await IslandPool.updateOne(
    { key: "default" },
    {
      $set: {
        enabled: true,
        poolBalance: 1000000,
        minTriggerAmount: 100000,
        payoutPercentages: { royalFlush: 0.8, straightFlush: 0.3, fourOfAKind: 0.2 },
      },
    }
  );
  const hand = await HandHistory.create({ handId, table: tableId, gameType: "poker" });
  const plan = await reservePayoutForHand({
    handId,
    tableId,
    gameType: "poker",
    reason: "showdown",
    community: ["Qh", "Jh", "Th", "2s", "3s"],
    seats: [{ userId, name: "Reserved winner", isBot: false, folded: false, hole: ["Ah", "Kh"] }],
  });

  assert.equal(plan.status, "reserved");
  assert.equal(plan.shareEach, 800000);
  assert.equal((await IslandPool.findOne({ key: "default" }).lean()).poolBalance, 200000);

  // These are deliberately changed after the hand: the outbox must not
  // recalculate eligibility or debit the pool a second time.
  await IslandMember.updateOne({ userId }, { $set: { active: false } });
  await IslandPool.updateOne({ key: "default" }, { $set: { poolBalance: 250000 } });
  await enqueueIslandJackpotJob({
    handId,
    handHistoryId: hand._id,
    tableId,
    payload: { settlementPlan: plan },
  });
  await processPokerPostSettlementJobs();

  assert.equal((await Wallet.findOne({ user: userId }).lean()).balance, 800000);
  assert.equal((await IslandWinner.countDocuments({ handId })), 1);
  assert.equal(
    (await IslandPool.findOne({ key: "default" }).lean()).poolBalance,
    250000,
    "worker did not recalculate or debit the later pool"
  );
});
