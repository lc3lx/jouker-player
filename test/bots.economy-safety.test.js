"use strict";

/**
 * BOT ECONOMY SAFETY — the single most important guarantee of the persistent-bot
 * change: giving a bot seat a REAL User id (so profiles/identity work) must NOT
 * let the bot move real coins through settlement. Settlement must still treat any
 * `isBot:true` seat as house-backed (userId nulled, payout 0), and human↔house
 * reconciliation must be byte-identical to a legacy synthetic-id bot.
 *
 * Uses the existing InMemorySettlementHarness so we exercise the REAL
 * settleGameOnFinish path (which calls participantsFromTableAndGame — the code
 * that nulls bot userIds).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { validateReconciliation } = require("../services/gameSettlementService");
const { InMemorySettlementHarness } = require("./helpers/inMemorySettlementHarness");

function withHarness(fn) {
  const harness = new InMemorySettlementHarness();
  harness.installMocks();
  const { settleGameOnFinish } = harness.loadGameSettlementService();
  return fn(harness, settleGameOnFinish).finally(() => harness.restoreMocks());
}

/**
 * Upgrade a harness-seeded table so its bot seats look like PERSISTENT bots:
 * the table seat's `user` and the gamePlayer's `userId` become the same real
 * ObjectId, and that id gets a funded wallet. A correctly-behaving settlement
 * must leave those wallets untouched.
 */
function makeBotsPersistent(harness, table, gamePlayers, buyIn) {
  const botWalletIds = [];
  gamePlayers.forEach((gp, idx) => {
    if (!gp.isBot) return;
    const botId = new mongoose.Types.ObjectId();
    gp.userId = String(botId); // persistent bot identity on the seat
    table.seats[idx].user = botId; // table seat now references a real bot user
    // Fund the bot's displayed wallet — settlement must never touch this.
    harness.wallets.set(String(botId), { userId: botId, balance: buyIn * 7, lockedBalance: buyIn });
    botWalletIds.push(String(botId));
  });
  return botWalletIds;
}

function snapshotWallets(harness, ids) {
  const snap = {};
  for (const id of ids) {
    const w = harness.getWallet(id);
    snap[id] = { balance: w.balance, lockedBalance: w.lockedBalance };
  }
  return snap;
}

async function runOne(gameType, gameResult) {
  await withHarness(async (harness, settleGameOnFinish) => {
    const buyIn = 1000;
    const { tableId, table, gamePlayers } = harness.seedTrixTable({
      buyIn,
      humanSeats: 2,
      botSeats: 2,
    });
    const botIds = makeBotsPersistent(harness, table, gamePlayers, buyIn);
    const before = snapshotWallets(harness, botIds);

    const result = await settleGameOnFinish({
      gameType,
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult,
      gamePlayers,
      rakePercent: 5,
    });

    assert.equal(result.success, true, `${gameType}: settlement completed`);

    // 1) The settlement plan nulls every bot userId and pays them nothing.
    for (const p of result.plan.participants) {
      if (p.isBot) {
        assert.equal(p.userId, null, `${gameType}: bot userId nulled in plan`);
        assert.equal(p.payout, 0, `${gameType}: bot receives no wallet payout`);
      }
    }
    // No bot id should appear among the credited winners.
    for (const w of result.plan.winners) {
      if (w.isBot) assert.equal(w.userId, null, `${gameType}: bot winner has no wallet id`);
    }

    // 2) Bot wallets are byte-identical before/after — never debited or credited.
    const after = snapshotWallets(harness, botIds);
    assert.deepEqual(after, before, `${gameType}: bot wallets untouched by settlement`);

    // 3) Human↔house reconciliation still balances to zero.
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true, `${gameType}: reconciliation balanced`);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0, `${gameType}: house+human nets to 0`);
  });
}

test("SAFETY: poker — persistent-bot seats never move coins; reconciliation intact", async () => {
  await runOne("poker", { winnerSeatIndices: [0] }); // a human wins
});

test("SAFETY: poker — a BOT winning pays the human via the house, not the bot's wallet", async () => {
  await runOne("poker", { winnerSeatIndices: [2] }); // a bot 'wins' the hand
});

test("SAFETY: trix — persistent-bot seats never move coins", async () => {
  await runOne("trix", { winnerIndex: 0, scores: [300, 100, 80, 60] });
});

test("SAFETY: trix — bot 'winner' does not receive a wallet payout", async () => {
  await runOne("trix", { winnerIndex: 2, scores: [80, 60, 300, 100] });
});

test("SAFETY: tarneeb41 — persistent-bot seats never move coins", async () => {
  await runOne("tarneeb41", { winnerTeam: 0 });
});

test("SAFETY: persistent-bot settlement matches legacy synthetic-bot settlement exactly", async () => {
  // Same scenario twice: once with legacy `bot_N` ids, once with real bot User
  // ids. The human/house money outcome must be identical.
  async function humanNet(persistent) {
    return withHarness(async (harness, settleGameOnFinish) => {
      const buyIn = 1000;
      const { tableId, table, gamePlayers } = harness.seedTrixTable({
        buyIn,
        humanSeats: 2,
        botSeats: 2,
      });
      if (persistent) makeBotsPersistent(harness, table, gamePlayers, buyIn);
      const humanIds = gamePlayers.filter((g) => !g.isBot).map((g) => String(g.userId));
      const before = humanIds.reduce((s, id) => {
        const w = harness.getWallet(id);
        return s + w.balance + w.lockedBalance;
      }, 0);

      const result = await settleGameOnFinish({
        gameType: "poker",
        tableId,
        sessionId: crypto.randomUUID(),
        gameResult: { winnerSeatIndices: [0] },
        gamePlayers,
        rakePercent: 5,
      });
      assert.equal(result.success, true);

      const after = humanIds.reduce((s, id) => {
        const w = harness.getWallet(id);
        return s + w.balance + w.lockedBalance;
      }, 0);
      return { delta: after - before, house: result.plan.houseNetDelta, rake: result.plan.totalRake };
    });
  }

  const legacy = await humanNet(false);
  const persistent = await humanNet(true);
  assert.deepEqual(persistent, legacy, "persistent-bot money outcome == legacy synthetic-bot outcome");
});
