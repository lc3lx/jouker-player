/**
 * Sic Bo wallet + settlement integration tests on an in-memory Mongo replica set.
 * Covers: bet persistence + debit, validation, settlement payout, double-settlement
 * prevention (idempotency), refund, and stuck-round recovery.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { resetMongoTransactionProbeForTests } = require("../services/walletLedgerService");
const Wallet = require("../models/walletModel");
const User = require("../models/userModel");
const SicBoRound = require("../models/sicboRoundModel");
const SicBoBet = require("../models/sicboBetModel");

const roundManager = require("../games/sicbo/sicboRoundManager");
const walletAdapter = require("../games/sicbo/sicboWalletAdapter");

let replSet;

async function seedUser(balance = 5_000_000) {
  const id = crypto.randomUUID().slice(0, 8);
  const user = await User.create({
    name: `P-${id}`,
    email: `p-${id}@test.local`,
    password: "testpass123",
    role: "user",
  });
  await Wallet.create({ user: user._id, balance, lockedBalance: 0 });
  return user;
}

async function balanceOf(userId) {
  const w = await Wallet.findOne({ user: userId }).lean();
  return w ? w.balance : 0;
}

/** Force a round's dice to a known result (bypasses provably-fair for deterministic asserts). */
async function forceResult(roundId, dice) {
  const { summarize } = require("../games/sicbo/sicboEngine");
  const s = summarize(dice);
  await SicBoRound.findOneAndUpdate(
    { roundId },
    {
      $set: {
        status: "RESULT",
        dice1: dice[0],
        dice2: dice[1],
        dice3: dice[2],
        total: s.total,
        isTriple: s.isTriple,
        resultBigSmall: s.bigSmall,
        resultOddEven: s.oddEven,
        resultAt: new Date(),
      },
    }
  );
}

test.before(async () => {
  process.env.NODE_ENV = "test";
  delete process.env.MONGO_STANDALONE;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = replSet.getUri();
  process.env.MONGODB_URI = uri;
  delete process.env.MONGO_URI;
  delete process.env.DB_URI;
  resetMongoTransactionProbeForTests();
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongoose.connect(uri, { dbName: "sicbo_test" });
});

test.after(async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
  resetMongoTransactionProbeForTests();
});

test.beforeEach(async () => {
  await Promise.all([
    Wallet.deleteMany({}),
    User.deleteMany({}),
    SicBoRound.deleteMany({}),
    SicBoBet.deleteMany({}),
  ]);
});

test("placeBet debits wallet and persists the bet in Mongo", async () => {
  const user = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });

  const res = await walletAdapter.placeBet({
    userId: user._id,
    roundId: round.roundId,
    betType: "big",
    amount: 10000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.balance, 990000);
  assert.equal(await balanceOf(user._id), 990000);

  const bet = await SicBoBet.findOne({ roundId: round.roundId, userId: user._id, betType: "big" });
  assert.ok(bet, "bet persisted");
  assert.equal(bet.amount, 10000);
  assert.equal(bet.status, "placed");
});

test("repeat bets on the same zone accumulate into one row", async () => {
  const user = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await walletAdapter.placeBet({ userId: user._id, roundId: round.roundId, betType: "big", amount: 10000 });
  const res = await walletAdapter.placeBet({ userId: user._id, roundId: round.roundId, betType: "big", amount: 20000 });
  assert.equal(res.totalOnZone, 30000);
  assert.equal(await balanceOf(user._id), 970000);
  const count = await SicBoBet.countDocuments({ roundId: round.roundId, userId: user._id, betType: "big" });
  assert.equal(count, 1);
});

test("placeBet rejects invalid stake, below-min, and insufficient balance", async () => {
  const poor = await seedUser(5000); // below one chip
  const round = await roundManager.openRound({ bettingMs: 60000 });

  await assert.rejects(
    walletAdapter.placeBet({ userId: poor._id, roundId: round.roundId, betType: "big", amount: 9999 }),
    (e) => e.code === "INVALID_STAKE"
  );
  await assert.rejects(
    walletAdapter.placeBet({ userId: poor._id, roundId: round.roundId, betType: "garbage", amount: 10000 }),
    (e) => e.code === "INVALID_BET_TYPE"
  );
  await assert.rejects(
    walletAdapter.placeBet({ userId: poor._id, roundId: round.roundId, betType: "big", amount: 10000 }),
    (e) => e.code === "INSUFFICIENT_BALANCE"
  );
  assert.equal(await balanceOf(poor._id), 5000, "no debit on rejected bets");
});

test("placeBet is rejected after betting closes", async () => {
  const user = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await SicBoRound.findOneAndUpdate({ roundId: round.roundId }, { $set: { status: "LOCKED" } });
  await assert.rejects(
    walletAdapter.placeBet({ userId: user._id, roundId: round.roundId, betType: "big", amount: 10000 }),
    (e) => e.code === "BETTING_CLOSED"
  );
});

test("settleRound pays winners, and is idempotent on replay (no double payout)", async () => {
  const winner = await seedUser(1_000_000);
  const loser = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });

  // winner bets big, loser bets small; force dice total 14 (big).
  await walletAdapter.placeBet({ userId: winner._id, roundId: round.roundId, betType: "big", amount: 100000 });
  await walletAdapter.placeBet({ userId: loser._id, roundId: round.roundId, betType: "small", amount: 100000 });
  assert.equal(await balanceOf(winner._id), 900000);
  assert.equal(await balanceOf(loser._id), 900000);

  await forceResult(round.roundId, [6, 5, 3]); // 14 → big
  const first = await roundManager.settleRound(round.roundId);
  assert.equal(first.round.status, "SETTLED");

  // big pays 1:1 → 100000 stake + 100000 = 200000 back.
  assert.equal(await balanceOf(winner._id), 1_100000);
  assert.equal(await balanceOf(loser._id), 900000);

  // Replay settlement — must not pay again.
  const second = await roundManager.settleRound(round.roundId);
  assert.equal(second.alreadySettled, true);
  assert.equal(await balanceOf(winner._id), 1_100000, "no double payout on replay");

  const bets = await SicBoBet.find({ roundId: round.roundId }).lean();
  assert.equal(bets.find((b) => String(b.userId) === String(winner._id)).status, "won");
  assert.equal(bets.find((b) => String(b.userId) === String(loser._id)).status, "lost");
});

test("house profit balances against player net across a round", async () => {
  const a = await seedUser(1_000_000);
  const b = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await walletAdapter.placeBet({ userId: a._id, roundId: round.roundId, betType: "big", amount: 100000 });
  await walletAdapter.placeBet({ userId: b._id, roundId: round.roundId, betType: "small", amount: 100000 });
  await forceResult(round.roundId, [6, 5, 3]); // big wins
  const { round: settled } = await roundManager.settleRound(round.roundId);

  // totalBet 200000, payout 200000 (big 1:1), house profit 0.
  assert.equal(settled.totalBetAmount, 200000);
  assert.equal(settled.totalPayout, 200000);
  assert.equal(settled.houseProfit, 0);
  assert.equal(settled.totalPlayers, 2);
});

test("abortAndRefund returns all placed stakes", async () => {
  const user = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await walletAdapter.placeBet({ userId: user._id, roundId: round.roundId, betType: "triple_6", amount: 50000 });
  assert.equal(await balanceOf(user._id), 950000);
  await roundManager.abortAndRefund(round.roundId, "test");
  assert.equal(await balanceOf(user._id), 1_000_000, "full refund");
  const bet = await SicBoBet.findOne({ roundId: round.roundId, userId: user._id });
  assert.equal(bet.status, "refunded");
});

test("recoverStuckRounds settles a round left in RESULT after a crash", async () => {
  const winner = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await walletAdapter.placeBet({ userId: winner._id, roundId: round.roundId, betType: "any_triple", amount: 10000 });
  // Simulate crash right after result, before settlement.
  await forceResult(round.roundId, [4, 4, 4]); // any triple → 30:1

  const summary = await roundManager.recoverStuckRounds();
  assert.ok(summary.find((s) => s.roundId === round.roundId && s.status === "SETTLED"));
  // any_triple pays 30:1 → 10000 + 300000 = 310000 back.
  assert.equal(await balanceOf(winner._id), 990000 + 310000);
});

test("single-die triple pays 3:1 through full settlement", async () => {
  const user = await seedUser(1_000_000);
  const round = await roundManager.openRound({ bettingMs: 60000 });
  await walletAdapter.placeBet({ userId: user._id, roundId: round.roundId, betType: "single_5", amount: 10000 });
  await forceResult(round.roundId, [5, 5, 5]); // three 5s
  await roundManager.settleRound(round.roundId);
  // single_5 with 3 matches → 10000 stake + 30000 = 40000 back.
  assert.equal(await balanceOf(user._id), 990000 + 40000);
});
