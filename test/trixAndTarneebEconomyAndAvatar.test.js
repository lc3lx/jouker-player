"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Tarneeb41Game = require("../games/tarneeb41/Tarneeb41Game");
const TrixGame = require("../games/trix/TrixGame");
const { validateReconciliation } = require("../services/gameSettlementService");
const { InMemorySettlementHarness } = require("./helpers/inMemorySettlementHarness");

function withHarness(fn) {
  const harness = new InMemorySettlementHarness();
  harness.installMocks();
  const { settleGameOnFinish } = harness.loadGameSettlementService();
  return fn(harness, settleGameOnFinish).finally(() => harness.restoreMocks());
}

test("Avatar: converting human to bot in Trix and Tarneeb clears avatar and cosmetics", async () => {
  // 1. Trix
  const trix = new TrixGame("room_trix", { mongoTableId: "table_trix" });
  trix.players = [
    {
      userId: "user_1",
      socketId: "sock_1",
      seatIndex: 0,
      chair: 0,
      isBot: false,
      displayName: "Player 1",
      avatar: "https://example.com/user1_photo.png",
      chips: 10000,
    },
  ];
  assert.equal(trix.convertHumanToBot("user_1"), true);
  assert.equal(trix.players[0].isBot, true);
  // Avatar MUST NOT remain as the vacated human's photo
  assert.notEqual(trix.players[0].avatar, "https://example.com/user1_photo.png");

  // Rejoining / restoring human at seat applies human's avatar
  assert.equal(
    await trix.replaceBotWithHuman(0, "user_1", "sock_new", "Player 1", {
      avatar: "https://example.com/user1_photo.png",
    }),
    true
  );
  assert.equal(trix.players[0].isBot, false);
  assert.equal(trix.players[0].avatar, "https://example.com/user1_photo.png");
  trix.destroy();

  // 2. Tarneeb 41
  const tarneeb = new Tarneeb41Game("room_t41", { mongoTableId: "table_t41" });
  tarneeb.players = [
    {
      userId: "user_2",
      socketId: "sock_2",
      seatIndex: 0,
      chair: 0,
      isBot: false,
      displayName: "Player 2",
      avatar: "https://example.com/user2_photo.png",
      chips: 10000,
    },
  ];
  assert.equal(tarneeb.convertHumanToBot("user_2"), true);
  assert.equal(tarneeb.players[0].isBot, true);
  // Avatar MUST NOT remain as the vacated human's photo
  assert.notEqual(tarneeb.players[0].avatar, "https://example.com/user2_photo.png");

  // Rejoining applies avatar
  assert.equal(
    await tarneeb.replaceBotWithHuman(0, "user_2", "sock_new", "Player 2", {
      avatar: "https://example.com/user2_photo.png",
    }),
    true
  );
  assert.equal(tarneeb.players[0].isBot, false);
  assert.equal(tarneeb.players[0].avatar, "https://example.com/user2_photo.png");
  tarneeb.destroy();
});

test("Economy: 1 human + 3 bots at 10,000 table in Trix Solo (اليهودية) — winner takes full 40,000 pool", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const buyIn = 10000;
    const tableId = new mongoose.Types.ObjectId();
    const humanId = new mongoose.Types.ObjectId();

    // In MongoDB, only human is seated (length 1)
    const table = {
      _id: tableId,
      gameType: "trix",
      minBuyIn: buyIn,
      buyIn,
      status: "playing",
      seats: [{ user: humanId, chips: buyIn, seatPosition: 0 }],
      activeSettlementId: null,
      tableNumber: 1,
      save: async () => table,
    };
    harness.tables.set(String(tableId), table);
    harness.wallets.set(String(humanId), {
      userId: humanId,
      balance: 50000,
      lockedBalance: buyIn,
    });
    harness.tableLocks.set(`${humanId}:${tableId}`, buyIn);

    // In engine, 4 players (1 human + 3 bots)
    const gamePlayers = [
      { userId: humanId, seatIndex: 0, isBot: false, chips: buyIn },
      { userId: "bot_1", seatIndex: 1, isBot: true, chips: buyIn },
      { userId: "bot_2", seatIndex: 2, isBot: true, chips: buyIn },
      { userId: "bot_3", seatIndex: 3, isBot: true, chips: buyIn },
    ];

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: {
        gameMode: "solo",
        winnerIndex: 0,
        scores: [500, 100, 80, -50],
      },
      gamePlayers,
    });

    assert.equal(result.success, true);
    // Total buy-in must be 4 * 10,000 = 40,000
    assert.equal(result.plan.totalBuyIn, 40000);
    assert.equal(result.plan.totalRake, 0); // 0% default rake for trix
    // Winner gets the full pool: 40,000
    assert.equal(result.plan.participants[0].payout, 40000);
    assert.equal(result.plan.participants[0].netDelta, 30000); // 40k payout - 10k buyin = +30k

    // Bot wallets are not touched
    assert.equal(result.plan.participants[1].payout, 0);
    assert.equal(result.plan.participants[2].payout, 0);
    assert.equal(result.plan.participants[3].payout, 0);

    // House reconciliation is balanced
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
  });
});

test("Economy: 1 human + 3 bots at 10,000 table in Trix Partnership (الشركة) — winning team splits 40,000 -> 20,000 each", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const buyIn = 10000;
    const tableId = new mongoose.Types.ObjectId();
    const humanId = new mongoose.Types.ObjectId();

    const table = {
      _id: tableId,
      gameType: "trix",
      minBuyIn: buyIn,
      buyIn,
      status: "playing",
      seats: [{ user: humanId, chips: buyIn, seatPosition: 0 }],
      activeSettlementId: null,
      tableNumber: 1,
      save: async () => table,
    };
    harness.tables.set(String(tableId), table);
    harness.wallets.set(String(humanId), {
      userId: humanId,
      balance: 50000,
      lockedBalance: buyIn,
    });
    harness.tableLocks.set(`${humanId}:${tableId}`, buyIn);

    // Human at seat 0, partner bot at seat 2 (Team 0: facing seats)
    const gamePlayers = [
      { userId: humanId, seatIndex: 0, isBot: false, chips: buyIn },
      { userId: "bot_1", seatIndex: 1, isBot: true, chips: buyIn },
      { userId: "bot_2", seatIndex: 2, isBot: true, chips: buyIn },
      { userId: "bot_3", seatIndex: 3, isBot: true, chips: buyIn },
    ];

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: {
        gameMode: "partnership",
        winnerTeam: 0, // Team 0 (seats 0 & 2) wins
        scores: [300, 50, 200, 100],
      },
      gamePlayers,
    });

    assert.equal(result.success, true);
    assert.equal(result.plan.totalBuyIn, 40000);
    assert.equal(result.plan.totalRake, 0);

    // Human at seat 0 receives exactly 20,000 (their 10,000 entry fee + 10,000 profit from opponents)
    assert.equal(result.plan.participants[0].payout, 20000);
    assert.equal(result.plan.participants[0].netDelta, 10000);

    // Partner bot at seat 2 gets virtualPayout 20000, but actual payout 0
    assert.equal(result.plan.participants[2].virtualPayout, 20000);
    assert.equal(result.plan.participants[2].payout, 0);

    // Reconciliation balances: human +10k, house -10k
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
  });
});

test("Economy: 1 human + 3 bots at 10,000 table in Tarneeb 41 (طرنيب) — winning team splits 40,000 -> 20,000 each", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const buyIn = 10000;
    const tableId = new mongoose.Types.ObjectId();
    const humanId = new mongoose.Types.ObjectId();

    const table = {
      _id: tableId,
      gameType: "tarneeb41",
      minBuyIn: buyIn,
      buyIn,
      status: "playing",
      seats: [{ user: humanId, chips: buyIn, seatPosition: 0 }],
      activeSettlementId: null,
      tableNumber: 1,
      save: async () => table,
    };
    harness.tables.set(String(tableId), table);
    harness.wallets.set(String(humanId), {
      userId: humanId,
      balance: 50000,
      lockedBalance: buyIn,
    });
    harness.tableLocks.set(`${humanId}:${tableId}`, buyIn);

    const gamePlayers = [
      { userId: humanId, seatIndex: 0, isBot: false, chips: buyIn },
      { userId: "bot_1", seatIndex: 1, isBot: true, chips: buyIn },
      { userId: "bot_2", seatIndex: 2, isBot: true, chips: buyIn },
      { userId: "bot_3", seatIndex: 3, isBot: true, chips: buyIn },
    ];

    const result = await settleGameOnFinish({
      gameType: "tarneeb41",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: {
        winnerTeam: 0,
        playerScores: [42, 20, 42, 20],
      },
      gamePlayers,
    });

    assert.equal(result.success, true);
    assert.equal(result.plan.totalBuyIn, 40000);
    assert.equal(result.plan.totalRake, 0); // 0% default rake for tarneeb41

    // Human at seat 0 receives 20,000
    assert.equal(result.plan.participants[0].payout, 20000);
    assert.equal(result.plan.participants[0].netDelta, 10000);

    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
  });
});

test("Economy: losing human receives 0 payout and forfeits entry fee (-10,000)", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const buyIn = 10000;
    const tableId = new mongoose.Types.ObjectId();
    const humanId = new mongoose.Types.ObjectId();

    const table = {
      _id: tableId,
      gameType: "trix",
      minBuyIn: buyIn,
      buyIn,
      status: "playing",
      seats: [{ user: humanId, chips: buyIn, seatPosition: 0 }],
      activeSettlementId: null,
      tableNumber: 1,
      save: async () => table,
    };
    harness.tables.set(String(tableId), table);
    harness.wallets.set(String(humanId), {
      userId: humanId,
      balance: 50000,
      lockedBalance: buyIn,
    });
    harness.tableLocks.set(`${humanId}:${tableId}`, buyIn);

    const gamePlayers = [
      { userId: humanId, seatIndex: 0, isBot: false, chips: buyIn },
      { userId: "bot_1", seatIndex: 1, isBot: true, chips: buyIn },
      { userId: "bot_2", seatIndex: 2, isBot: true, chips: buyIn },
      { userId: "bot_3", seatIndex: 3, isBot: true, chips: buyIn },
    ];

    // Team 1 (opponent bots) wins
    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: {
        gameMode: "partnership",
        winnerTeam: 1,
        scores: [50, 300, 100, 200],
      },
      gamePlayers,
    });

    assert.equal(result.success, true);
    // Losing human gets 0 payout, loses 10,000
    assert.equal(result.plan.participants[0].payout, 0);
    assert.equal(result.plan.participants[0].netDelta, -10000);

    // House collects the lost entry fee (+10,000)
    assert.equal(result.plan.houseNetDelta, 10000);

    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
  });
});
