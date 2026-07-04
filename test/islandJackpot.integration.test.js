"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { withHarness, ISLAND_HANDS } = require("./helpers/islandJackpotHarness");
const IslandMember = require("../models/islandMemberModel");
const IslandWinner = require("../models/islandWinnerModel");
const IslandHistory = require("../models/islandHistoryModel");
const JackpotTransaction = require("../models/jackpotTransactionModel");
const { evaluateIslandHand } = require("../utils/islandJackpotHand");
const { computePoolFlags } = require("../utils/islandJackpotLogic");
const walletLedgerService = require("../services/walletLedgerService");

for (const [name, cards] of Object.entries(ISLAND_HANDS)) {
  const ev = evaluateIslandHand(cards.hole, cards.community);
  assert.ok(ev, `fixture ${name} must evaluate`);
  assert.equal(ev.handType, name, `fixture ${name} hand type`);
}

describe("Island Jackpot — integration (MongoDB replica set)", () => {
  test("join — wallet deduction + pool increase + member created", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 50_000, poolBalance: 0 });

      const before = await h.getWalletBalance(user._id);
      const res = await h.joinMember(user);
      assert.equal(res.statusCode, 200);
      assert.equal(res.data.data.isMember, true);

      const after = await h.getWalletBalance(user._id);
      assert.equal(before - after, 50_000);

      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 50_000);
      assert.equal(await IslandMember.countDocuments({ userId: user._id, active: true }), 1);
      assert.equal(await IslandHistory.countDocuments({ type: "join", userId: user._id }), 1);
    });
  });

  test("trigger — pool armed when minTrigger reached", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 80_000, entryFee: 40_000, poolBalance: 0 });

      await h.joinMember(user);
      let pool = await h.getPool();
      assert.equal(computePoolFlags(pool).armed, false);

      const user2 = await h.createUser({ balance: 500_000, name: "P2" });
      await h.joinMember(user2);
      pool = await h.getPool();
      assert.equal(pool.poolBalance, 80_000);
      assert.equal(computePoolFlags(pool).armed, true);
    });
  });

  test("hot jackpot — visual threshold separate from armed", async () => {
    await withHarness(async (h) => {
      await h.configurePool({
        minTriggerAmount: 200_000,
        hotJackpotThreshold: 50_000,
        entryFee: 60_000,
        poolBalance: 0,
      });
      const user = await h.createUser({ balance: 1_000_000 });
      await h.joinMember(user);
      const pool = await h.getPool();
      assert.equal(computePoolFlags(pool).armed, false);
      assert.equal(computePoolFlags(pool).hotJackpot, true);
    });
  });

  test("royal flush payout — 80% pool to winner wallet", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 1_000_000 });
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 10_000, poolBalance: 500_000 });
      await h.joinMember(user);

      const handId = crypto.randomUUID();
      const beforeWallet = await h.getWalletBalance(user._id);
      await h.onHandSettled({
        handId,
        tableId: "table-1",
        gameType: "poker",
        community: ISLAND_HANDS.royalFlush.community,
        seats: [h.buildSeat(user, "royalFlush")],
        reason: "showdown",
      });

      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 102_000);
      const winner = await IslandWinner.findOne({ handId }).lean();
      assert.ok(winner);
      assert.equal(winner.payoutAmount, 408_000);
      assert.equal(winner.handType, "royalFlush");

      const afterWallet = await h.getWalletBalance(user._id);
      assert.equal(afterWallet - beforeWallet, 408_000);
    });
  });

  test("straight flush payout — 30% pool", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 50_000, entryFee: 5_000, poolBalance: 1_000_000 });
      await h.joinMember(user);

      const handId = crypto.randomUUID();
      await h.onHandSettled({
        handId,
        tableId: "t2",
        gameType: "poker",
        community: ISLAND_HANDS.straightFlush.community,
        seats: [h.buildSeat(user, "straightFlush")],
        reason: "showdown",
      });

      const winner = await IslandWinner.findOne({ handId }).lean();
      assert.equal(winner.payoutAmount, 301_500);
      assert.equal(winner.handType, "straightFlush");
    });
  });

  test("four of a kind payout — 20% pool", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 50_000, entryFee: 5_000, poolBalance: 500_000 });
      await h.joinMember(user);

      const handId = crypto.randomUUID();
      await h.onHandSettled({
        handId,
        tableId: "t3",
        gameType: "poker",
        community: ISLAND_HANDS.fourOfAKind.community,
        seats: [h.buildSeat(user, "fourOfAKind")],
        reason: "showdown",
      });

      const winner = await IslandWinner.findOne({ handId }).lean();
      assert.equal(winner.payoutAmount, 101_000);
      assert.equal(winner.handType, "fourOfAKind");
    });
  });

  test("multiple winners — split royal flush pool between two", async () => {
    await withHarness(async (h) => {
      const u1 = await h.createUser({ balance: 1_000_000, name: "W1" });
      const u2 = await h.createUser({ balance: 1_000_000, name: "W2" });
      await h.configurePool({
        minTriggerAmount: 100_000,
        entryFee: 10_000,
        poolBalance: 800_000,
        maxWinnersPerEvent: 2,
      });
      await h.joinMember(u1);
      await h.joinMember(u2);

      const handId = crypto.randomUUID();
      await h.onHandSettled({
        handId,
        tableId: "t-multi",
        gameType: "poker",
        community: ISLAND_HANDS.royalFlush.community,
        seats: [
          h.buildSeat(u1, "royalFlush"),
          h.buildSeat(u2, "royalFlush"),
        ],
        reason: "showdown",
      });

      const winners = await IslandWinner.find({ handId }).lean();
      assert.equal(winners.length, 2);
      const totalPaid = winners.reduce((s, w) => s + w.payoutAmount, 0);
      assert.equal(totalPaid, 656_000);
      assert.equal(winners[0].payoutAmount, 328_000);
    });
  });

  test("duplicate payout blocked — same handId twice", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 50_000, entryFee: 5_000, poolBalance: 200_000 });
      await h.joinMember(user);

      const handId = crypto.randomUUID();
      const params = {
        handId,
        tableId: "dup",
        gameType: "poker",
        community: ISLAND_HANDS.fourOfAKind.community,
        seats: [h.buildSeat(user, "fourOfAKind")],
        reason: "showdown",
      };
      await h.onHandSettled(params);
      await h.onHandSettled(params);

      assert.equal(await IslandWinner.countDocuments({ handId }), 1);
      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 164_000);
    });
  });

  test("idempotent join — duplicate idempotency key", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 25_000, poolBalance: 0 });
      const key = crypto.randomUUID();

      await h.joinMember(user, { idempotencyKey: key });
      const dup = await h.joinMember(user, { idempotencyKey: key });
      assert.equal(dup.data.data.duplicate, true);
      assert.equal(await IslandMember.countDocuments({ userId: user._id }), 1);
      assert.equal(await JackpotTransaction.countDocuments({ idempotencyKey: key }), 1);
    });
  });

  test("concurrent joins — many users in parallel", async () => {
    await withHarness(async (h) => {
      await h.configurePool({ minTriggerAmount: 500_000, entryFee: 10_000, poolBalance: 0 });
      const users = await Promise.all(
        Array.from({ length: 20 }, (_, i) => h.createUser({ balance: 500_000, name: `C${i}` }))
      );

      const results = await Promise.allSettled(users.map((u) => h.joinMember(u)));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      assert.equal(ok, 20);
      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 200_000);
      assert.equal(await IslandMember.countDocuments({ active: true }), 20);
    });
  });

  test("rollback on join failure — pool and member unchanged", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 5_000 });
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 50_000, poolBalance: 10_000 });

      await assert.rejects(() => h.joinMember(user), (err) => {
        assert.match(String(err.message || err), /INSUFFICIENT|402|balance/i);
        return true;
      });

      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 10_000);
      assert.equal(await IslandMember.countDocuments({ userId: user._id }), 0);
      assert.equal(await IslandHistory.countDocuments({ type: "join", userId: user._id }), 0);
    });
  });

  test("rollback on simulated ledger failure mid-transaction", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 25_000, poolBalance: 0 });

      const orig = walletLedgerService.ledgerWithdraw;
      walletLedgerService.ledgerWithdraw = async () => {
        throw new Error("SIMULATED_LEDGER_FAILURE");
      };

      try {
        await assert.rejects(() => h.joinMember(user), /SIMULATED_LEDGER_FAILURE/);
      } finally {
        walletLedgerService.ledgerWithdraw = orig;
      }

      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 0);
      assert.equal(await IslandMember.countDocuments({ userId: user._id }), 0);
    });
  });

  test("non-showdown hands do not trigger payout", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 50_000, entryFee: 5_000, poolBalance: 300_000 });
      await h.joinMember(user);

      await h.onHandSettled({
        handId: crypto.randomUUID(),
        tableId: "fold",
        gameType: "poker",
        community: ISLAND_HANDS.royalFlush.community,
        seats: [h.buildSeat(user, "royalFlush")],
        reason: "fold_win",
      });

      assert.equal(await IslandWinner.countDocuments({}), 0);
      const pool = await h.getPool();
      assert.equal(pool.poolBalance, 305_000);
    });
  });

  test("buildStatusSnapshot — read-only, no pool mutation", async () => {
    await withHarness(async (h) => {
      await h.configurePool({ minTriggerAmount: 100_000, entryFee: 10_000, poolBalance: 150_000 });
      const poolBefore = await h.getPool();
      const versionBefore = poolBefore.version;

      await h.service.buildStatusSnapshot();
      await h.service.buildStatusSnapshot();

      const poolAfter = await h.getPool();
      assert.equal(poolAfter.version, versionBefore);
    });
  });
});

describe("Island Jackpot — payout lock (concurrent hand settlement)", () => {
  test("parallel onHandSettled — only one payout", async () => {
    await withHarness(async (h) => {
      const user = await h.createUser({ balance: 500_000 });
      await h.configurePool({ minTriggerAmount: 50_000, entryFee: 5_000, poolBalance: 400_000 });
      await h.joinMember(user);

      const handId = crypto.randomUUID();
      const params = {
        handId,
        tableId: "race",
        gameType: "poker",
        community: ISLAND_HANDS.straightFlush.community,
        seats: [h.buildSeat(user, "straightFlush")],
        reason: "showdown",
      };

      await Promise.all([
        h.onHandSettled(params),
        h.onHandSettled(params),
        h.onHandSettled(params),
      ]);

      assert.equal(await IslandWinner.countDocuments({ handId }), 1);
    });
  });
});
