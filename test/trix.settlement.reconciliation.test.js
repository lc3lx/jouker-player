const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSettlementPlan,
  validateReconciliation,
} = require("../services/gameSettlementService");

function mkHuman(seatIndex, buyIn = 1000) {
  return { userId: `human_${seatIndex}`, seatIndex, buyIn, isBot: false };
}

function mkBot(seatIndex, buyIn = 1000) {
  return { userId: null, seatIndex, buyIn, isBot: true };
}

function assertBalanced(plan) {
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true, `unbalanced delta=${recon.delta}`);
  assert.equal(recon.houseNetDelta + recon.humanNetDelta, 0);
  return recon;
}

test("human vs human — 4 humans, single winner", () => {
  const participants = [0, 1, 2, 3].map((i) => mkHuman(i, 500));
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [220, 180, 90, 40] },
    participants,
    rakePercent: 5,
  });
  assertBalanced(plan);
  assert.equal(plan.totalHumanBuyIn, 2000);
  assert.equal(plan.participants.filter((p) => p.isWinner).length, 1);
});

test("human vs bots — bot wins, humans lose all buy-ins to house", () => {
  const participants = [mkHuman(0), mkHuman(1), mkBot(2), mkBot(3)];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [10, 20, 300, 5] },
    participants,
    rakePercent: 5,
  });
  assertBalanced(plan);
  assert.equal(plan.totalPayout, 0);
  assert.equal(plan.houseNetDelta, 2000);
  assert.equal(plan.participants[0].netDelta, -1000);
  assert.equal(plan.participants[1].netDelta, -1000);
});

test("mixed table — 2 humans + 2 bots, human wins", () => {
  const participants = [mkHuman(0), mkHuman(1), mkBot(2), mkBot(3)];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [250, 80, 60, 40] },
    participants,
    rakePercent: 5,
  });
  assertBalanced(plan);
  assert.equal(plan.totalBuyIn, 4000);
  assert.equal(plan.totalHumanBuyIn, 2000);
  assert.equal(plan.totalBotBuyIn, 2000);
  assert.equal(plan.participants[0].payout, 3800);
  assert.equal(plan.participants[0].netDelta, 2800);
  assert.equal(plan.houseNetDelta, -1800);
});

test("mixed table — tie between two humans", () => {
  const participants = [mkHuman(0), mkHuman(1), mkBot(2), mkBot(3)];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [200, 200, 50, 30] },
    participants,
    rakePercent: 5,
  });
  assertBalanced(plan);
  const winners = plan.participants.filter((p) => p.isWinner && !p.isBot);
  assert.equal(winners.length, 2);
  assert.equal(winners[0].payout + winners[1].payout, plan.totalPayout);
});

test("humanNetDelta + houseNetDelta = 0 for all-buy-in variants", () => {
  const scenarios = [
    { participants: [0, 1].map((i) => mkHuman(i)), scores: [100, 50] },
    {
      participants: [mkHuman(0), mkHuman(1), mkBot(2), mkBot(3)],
      scores: [100, 50, 200, 10],
    },
    {
      participants: [0, 1, 2, 3].map((i) => mkHuman(i)),
      scores: [50, 50, 50, 50],
    },
  ];
  for (const s of scenarios) {
    const plan = buildSettlementPlan({
      gameType: "trix",
      gameResult: { scores: s.scores },
      participants: s.participants,
      rakePercent: 5,
    });
    assertBalanced(plan);
  }
});
