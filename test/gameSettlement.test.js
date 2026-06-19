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

test("2 players — winner takes pool minus rake", () => {
  const participants = mkParticipants(2, 1000);
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { winnerIndex: 0, scores: [100, 50] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalBuyIn, 2000);
  assert.equal(plan.totalRake, 100);
  assert.equal(plan.totalPayout, 1900);
  assert.equal(plan.participants[0].payout, 1900);
  assert.equal(plan.participants[0].netDelta, 900);
  assert.equal(plan.participants[1].payout, 0);
  assert.equal(plan.participants[1].netDelta, -1000);
});

test("4 players — single winner", () => {
  const participants = mkParticipants(4, 500);
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [200, 100, 80, 60] },
    participants,
    rakePercent: 10,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalBuyIn, 2000);
  assert.equal(plan.totalRake, 200);
  assert.equal(plan.totalPayout, 1800);
  assert.equal(plan.participants.filter((p) => p.isWinner).length, 1);
  assert.equal(plan.participants[0].payout, 1800);
});

test("trix tie — winnings split equally", () => {
  const participants = mkParticipants(4, 1000);
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [100, 100, 50, 40] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  const winners = plan.participants.filter((p) => p.isWinner);
  assert.equal(winners.length, 2);
  assert.equal(winners[0].payout + winners[1].payout, plan.totalPayout);
});

test("all winners — 4-way tie splits pool", () => {
  const participants = mkParticipants(4, 1000);
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [50, 50, 50, 50] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.participants.every((p) => p.isWinner), true);
  const payouts = plan.participants.map((p) => p.payout);
  assert.ok(payouts.every((p) => p === 950));
});

test("tarneeb41 — winning team splits pool", () => {
  const participants = mkParticipants(4, 1000);
  const plan = buildSettlementPlan({
    gameType: "tarneeb41",
    gameResult: { winnerTeam: 0, playerScores: [41, 10, 5, 8] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.participants[0].isWinner, true);
  assert.equal(plan.participants[2].isWinner, true);
  assert.equal(plan.participants[0].payout + plan.participants[2].payout, plan.totalPayout);
});

test("bot winner — humans lose and house collects", () => {
  const participants = [
    { userId: "u0", seatIndex: 0, buyIn: 1000, isBot: false },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: null, seatIndex: 3, buyIn: 1000, isBot: true },
  ];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [10, 20, 200, 5] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalBuyIn, 4000);
  assert.equal(plan.totalHumanBuyIn, 2000);
  assert.equal(plan.totalBotBuyIn, 2000);
  assert.equal(plan.totalPayout, 0);
  assert.equal(plan.totalRake, 200);
  assert.equal(plan.houseNetDelta, 2000);
  assert.equal(plan.participants[0].netDelta, -1000);
  assert.equal(plan.participants[1].netDelta, -1000);
});

test("human winner vs bots — house subsidizes bot contribution", () => {
  const participants = [
    { userId: "u0", seatIndex: 0, buyIn: 1000, isBot: false },
    { userId: "u1", seatIndex: 1, buyIn: 1000, isBot: false },
    { userId: null, seatIndex: 2, buyIn: 1000, isBot: true },
    { userId: null, seatIndex: 3, buyIn: 1000, isBot: true },
  ];
  const plan = buildSettlementPlan({
    gameType: "trix",
    gameResult: { scores: [200, 20, 10, 5] },
    participants,
    rakePercent: 5,
  });
  const recon = validateReconciliation(plan);
  assert.equal(recon.balanced, true);
  assert.equal(plan.totalPayout, 3800);
  assert.equal(plan.participants[0].payout, 3800);
  assert.equal(plan.participants[0].netDelta, 2800);
  assert.equal(plan.houseNetDelta, -1800);
});

test("idempotency key is stable for same session + result", () => {
  const a = buildIdempotencyKey({
    tableId: "abc",
    gameType: "trix",
    sessionId: "sess-1",
    gameResult: { winnerIndex: 0, scores: [10, 5, 3, 1] },
  });
  const b = buildIdempotencyKey({
    tableId: "abc",
    gameType: "trix",
    sessionId: "sess-1",
    gameResult: { winnerIndex: 0, scores: [10, 5, 3, 1] },
  });
  const c = buildIdempotencyKey({
    tableId: "abc",
    gameType: "trix",
    sessionId: "sess-2",
    gameResult: { winnerIndex: 0, scores: [10, 5, 3, 1] },
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("resolveWinnerSeatIndices handles tarneeb41 teams", () => {
  const winners = resolveWinnerSeatIndices("tarneeb41", { winnerTeam: 1 }, 4);
  assert.deepEqual(winners.sort(), [1, 3]);
});

test("reconciliation fails loudly when plan is unbalanced", () => {
  const bad = { totalBuyIn: 1000, totalPayout: 500, totalRake: 100 };
  const recon = validateReconciliation(bad);
  assert.equal(recon.balanced, false);
  assert.equal(recon.delta, 400);
});

test("duplicate settlement idempotency — same key produces same string", () => {
  const key1 = buildIdempotencyKey({
    tableId: "table1",
    gameType: "tarneeb41",
    sessionId: "uuid-123",
    gameResult: { winnerTeam: 0 },
  });
  const key2 = buildIdempotencyKey({
    tableId: "table1",
    gameType: "tarneeb41",
    sessionId: "uuid-123",
    gameResult: { winnerTeam: 0 },
  });
  assert.equal(key1, key2);
});

test("server restart recovery — ledger guard concept (stable plan after recompute)", () => {
  const participants = mkParticipants(2, 1000);
  const gameResult = { winnerIndex: 1, scores: [20, 80] };
  const planA = buildSettlementPlan({
    gameType: "trix",
    gameResult,
    participants,
    rakePercent: 5,
  });
  const planB = buildSettlementPlan({
    gameType: "trix",
    gameResult,
    participants,
    rakePercent: 5,
  });
  assert.deepEqual(validateReconciliation(planA), validateReconciliation(planB));
  assert.equal(planA.totalPayout, planB.totalPayout);
});
