/**
 * Final Release platform tests — unit coverage for new services.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const tournamentEngine = require("../services/tournamentEngineService");
const playerAnalytics = require("../services/playerAnalyticsService");
const { sha256Buffer, resolveProvider } = require("../utils/storage/storageProvider");
const handEvidenceService = require("../services/handEvidenceService");
const riskScore = require("../services/riskScoreService");

test("tournamentEngine blind schedule resolves level", () => {
  const t = { blindSchedule: tournamentEngine.BLIND_SCHEDULES.sitngo };
  const level = tournamentEngine.getBlindLevel(t, 3);
  assert.equal(level.level, 1);
  const level2 = tournamentEngine.getBlindLevel(t, 6);
  assert.equal(level2.level, 2);
});

test("tournamentEngine balanceTables moves seat from large table", () => {
  const tables = [
    { tableNumber: 1, seats: [{ user: "a" }], status: "active" },
    { tableNumber: 2, seats: [{ user: "b" }, { user: "c" }, { user: "d" }], status: "active" },
  ];
  const balanced = tournamentEngine.balanceTables(tables);
  const sizes = balanced.map((t) => t.seats.length).sort();
  assert.deepEqual(sizes, [2, 2]);
});

test("tournamentEngine prize distribution", () => {
  const t = {
    prizePool: 1000,
    prizeDistribution: [
      { place: 1, percent: 50 },
      { place: 2, percent: 30 },
      { place: 3, percent: 20 },
    ],
    participants: [
      { user: "u1", finishPlace: 1 },
      { user: "u2", finishPlace: 2 },
      { user: "u3", finishPlace: 3 },
    ],
  };
  const prizes = tournamentEngine.distributePrizes(t);
  assert.equal(prizes[0].amount, 500);
  assert.equal(prizes[1].amount, 300);
  assert.equal(prizes[2].amount, 200);
});

test("playerAnalytics computeDerived metrics", () => {
  const derived = playerAnalytics.computeDerived({
    handsPlayed: 100,
    handsWon: 25,
    totalProfit: 500,
    totalInvested: 1000,
    totalPotSeen: 5000,
    biggestPotWon: 200,
    longestWinStreak: 5,
    longestLoseStreak: 3,
    rawCounters: {
      voluntary: 30,
      pfr: 20,
      threeBet: 5,
      facedThreeBet: 10,
      foldedToThreeBet: 4,
      cbet: 15,
      cbetOpportunity: 20,
      foldToCbet: 6,
      facedCbet: 12,
      betsRaises: 40,
      calls: 20,
      checks: 30,
      sawFlop: 50,
      sawShowdown: 20,
      wonShowdown: 10,
      stealAttempt: 8,
      foldBb: 5,
      foldSb: 3,
      checkRaise: 4,
    },
  });
  assert.equal(derived.vpip, 30);
  assert.equal(derived.pfr, 20);
  assert.ok(derived.aggressionFactor > 0);
  assert.equal(derived.largestPot, 200);
  assert.equal(derived.winningStreak, 5);
});

test("storageProvider sha256 deterministic", () => {
  const a = sha256Buffer(Buffer.from("test"));
  const b = sha256Buffer(Buffer.from("test"));
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("storageProvider defaults to local", () => {
  const prev = process.env.STORAGE_PROVIDER;
  delete process.env.STORAGE_PROVIDER;
  assert.equal(resolveProvider(), "local");
  if (prev) process.env.STORAGE_PROVIDER = prev;
});

test("riskScore returns structured response", async () => {
  const result = await riskScore.computeRiskScore("user123");
  assert.ok(result.score >= 0);
  assert.ok(["low", "medium", "high"].includes(result.level));
  assert.ok(Array.isArray(result.factors));
});

test("handEvidence buildSearchableText via createHandEvidencePackage export", () => {
  assert.equal(typeof handEvidenceService.createHandEvidencePackage, "function");
  assert.equal(typeof handEvidenceService.searchEvidence, "function");
});

test("tournament lifecycle states defined", () => {
  assert.ok(tournamentEngine.LIFECYCLE.includes("registering"));
  assert.ok(tournamentEngine.LIFECYCLE.includes("final_table"));
  assert.ok(tournamentEngine.LIFECYCLE.includes("finished"));
});
