const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSettlementPlan,
  validateReconciliation,
  resolveWinnerSeatIndices,
  buildIdempotencyKey,
} = require("../services/gameSettlementService");

function mkParticipants(count, buyIn = 1000) {
  return Array.from({ length: count }, (_, seatIndex) => ({
    userId: `user_${seatIndex}`,
    seatIndex,
    buyIn,
    isBot: false,
  }));
}

test("tarneeb41 team 0 wins — pool split between seats 0 and 2", () => {
  const participants = mkParticipants(4, 1000);
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 0, playerScores: [41, 12, 8, 5] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalBuyIn, 4000);
  assert.equal(plan.totalRake, 200);
  assert.equal(plan.totalPayout, 3800);
  assert.equal(plan.participants[0].isWinner, true);
  assert.equal(plan.participants[2].isWinner, true);
  assert.equal(plan.participants[0].payout + plan.participants[2].payout, plan.totalPayout);
  assert.equal(plan.participants[1].payout, 0);
  assert.equal(plan.participants[3].payout, 0);
});

test("tarneeb41 team 1 wins — seats 1 and 3 share payout", () => {
  const participants = mkParticipants(4, 500);
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 1, playerScores: [20, 41, 15, 10] },
    participants,
    rakePercent: 10,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.participants[1].isWinner, true);
  assert.equal(plan.participants[3].isWinner, true);
  assert.equal(plan.participants[1].payout + plan.participants[3].payout, plan.totalPayout);
});

test("tarneeb41 bot winners — humans lose buy-in, house collects", () => {
  const participants = [
    { userId: null, seatIndex: 0, buyIn: 1000, isBot: true },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: "u3", seatIndex: 3, buyIn: 1000, isBot: false },
  ];
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 0, playerScores: [41, 10, 5, 3] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalPayout, 0);
  assert.equal(plan.participants[1].netDelta, -1000);
  assert.equal(plan.participants[3].netDelta, -1000);
  assert.ok(plan.houseNetDelta > 0);
});

test("tarneeb41 human winners vs bots — house subsidizes bot pool share", () => {
  const participants = [
    { userId: null, seatIndex: 0, buyIn: 1000, isBot: true },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: "u3", seatIndex: 3, buyIn: 1000, isBot: false },
  ];
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 1, playerScores: [10, 41, 5, 8] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.participants[1].payout + plan.participants[3].payout, plan.totalPayout);
  assert.ok(plan.participants[1].netDelta > 0);
  assert.ok(plan.participants[3].netDelta > 0);
  assert.ok(plan.houseNetDelta < 0);
});

test("tarneeb41 settlement idempotency key is stable", () => {
  const keyA = buildIdempotencyKey({
    tableId: "t41-1",
    gameType: "tarneeb41",
    sessionId: "sess-abc",
    gameResult: { winnerTeam: 0, playerScores: [41, 10, 5, 8] },
  });
  const keyB = buildIdempotencyKey({
    tableId: "t41-1",
    gameType: "tarneeb41",
    sessionId: "sess-abc",
    gameResult: { winnerTeam: 0, playerScores: [41, 10, 5, 8] },
  });
  assert.equal(keyA, keyB);
});

test("tarneeb41 resolveWinnerSeatIndices maps teams correctly", () => {
  assert.deepEqual(resolveWinnerSeatIndices("tarneeb41", { winnerTeam: 0 }, 4).sort(), [0, 2]);
  assert.deepEqual(resolveWinnerSeatIndices("tarneeb41", { winnerTeam: 1 }, 4).sort(), [1, 3]);
});

test("tarneeb41 recompute plan after server restart — identical reconciliation", () => {
  const participants = mkParticipants(4, 750);
  const gameResult = { winnerTeam: 0, playerScores: [41, 20, 15, 10] };
  const planA = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult,
    participants,
    rakePercent: 5,
  });
  const planB = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult,
    participants,
    rakePercent: 5,
  });
  assert.deepEqual(validateReconciliation(planA), validateReconciliation(planB));
  assert.equal(planA.totalPayout, planB.totalPayout);
  assert.equal(planA.totalRake, planB.totalRake);
});
