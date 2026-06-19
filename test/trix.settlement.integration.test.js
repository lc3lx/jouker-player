/**
 * Trix settlement integration — mocked Mongo + wallet ledger path.
 * Run: node --test backend/test/trix.settlement.integration.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  buildSettlementPlan,
  validateReconciliation,
} = require("../services/gameSettlementService");
const { InMemorySettlementHarness } = require("./helpers/inMemorySettlementHarness");

function withHarness(fn) {
  const harness = new InMemorySettlementHarness();
  harness.installMocks();
  const { settleGameOnFinish } = harness.loadGameSettlementService();
  return fn(harness, settleGameOnFinish).finally(() => harness.restoreMocks());
}

test("trix 4-human winner — wallets credited, strict reconciliation", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const { tableId, gamePlayers } = harness.seedTrixTable({
      buyIn: 1000,
      humanSeats: 4,
      botSeats: 0,
    });
    const winnerId = String(gamePlayers[0].userId);
    const beforeWinner = harness.getWallet(winnerId);
    const beforeNet = beforeWinner.balance + beforeWinner.lockedBalance;

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: { winnerIndex: 0, scores: [300, 100, 80, 60] },
      gamePlayers,
      rakePercent: 5,
    });

    assert.equal(result.success, true);
    assert.equal(result.settlement.settlementStatus, "completed");
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);

    const afterWinner = harness.getWallet(winnerId);
    const afterNet = afterWinner.balance + afterWinner.lockedBalance;
    assert.ok(afterNet > beforeNet, "winner total wallet should increase after payout");
    const loser = harness.getWallet(String(gamePlayers[1].userId));
    assert.ok(loser.lockedBalance < 1000, "loser should lose buy-in from locked balance");
  });
});

test("trix human vs bots — human winner subsidized by house", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const { tableId, gamePlayers } = harness.seedTrixTable({
      buyIn: 1000,
      humanSeats: 2,
      botSeats: 2,
    });

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: { winnerIndex: 0, scores: [250, 80, 60, 40] },
      gamePlayers,
      rakePercent: 5,
    });

    assert.equal(result.success, true);
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
    assert.equal(result.plan.totalBuyIn, 4000);
    assert.equal(result.plan.totalHumanBuyIn, 2000);
    assert.ok(result.plan.participants[0].payout > 0);
    assert.ok(harness.houseWallet.lockedBalance < 0, "house subsidizes bot pool share");
  });
});

test("trix bot winner — humans lose buy-in, house collects", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const { tableId, gamePlayers } = harness.seedTrixTable({
      buyIn: 1000,
      humanSeats: 2,
      botSeats: 2,
    });

    const result = await settleGameOnFinish({
      gameType: "trix",
      tableId,
      sessionId: crypto.randomUUID(),
      gameResult: { scores: [10, 20, 300, 5] },
      gamePlayers,
      rakePercent: 5,
    });

    assert.equal(result.success, true);
    const recon = validateReconciliation(result.plan);
    assert.equal(recon.balanced, true);
    assert.equal(result.plan.totalPayout, 0);
    assert.equal(recon.humanNetDelta, -2000);
    assert.equal(recon.houseNetDelta, 2000);
    assert.equal(recon.rake, 200);
  });
});

test("trix settlement idempotency — duplicate call returns completed settlement", async () => {
  await withHarness(async (harness, settleGameOnFinish) => {
    const { tableId, gamePlayers } = harness.seedTrixTable({
      buyIn: 500,
      humanSeats: 4,
      botSeats: 0,
    });
    const params = {
      gameType: "trix",
      tableId,
      sessionId: "sess-idem-1",
      gameResult: { winnerIndex: 1, scores: [50, 200, 40, 30] },
      gamePlayers,
      rakePercent: 5,
    };

    const first = await settleGameOnFinish(params);
    const second = await settleGameOnFinish(params);

    assert.equal(first.success, true);
    assert.equal(second.duplicate, true);
    assert.equal(first.settlement.settlementId, second.settlement.settlementId);
  });
});

test("trix plan + ledger invariant — sum(netDelta) + totalRake balances pool", () => {
  const participants = [
    { userId: "u0", seatIndex: 0, buyIn: 1000, isBot: false },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: null, seatIndex: 3, buyIn: 1000, isBot: true },
  ];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [180, 120, 90, 70] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  const humanNetSum = plan.participants
    .filter((p) => !p.isBot)
    .reduce((s, p) => s + p.netDelta, 0);
  assert.equal(humanNetSum + plan.houseNetDelta, 0);
  assert.equal(recon.humanNetDelta + recon.houseNetDelta, 0);
  assert.equal(plan.totalBuyIn, plan.totalRake + plan.totalPayout);
});
