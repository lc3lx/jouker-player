/**
 * Phase 3 platform foundation tests.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { deriveMinimumBet } = require("../utils/poker/tableBettingConfig");
const { buildHandAuditHash } = require("../services/auditService");
const replayService = require("../services/replayService");
const spectatorDelay = require("../services/spectatorDelayService");

test("deriveMinimumBet unchanged for platform imports", () => {
  assert.equal(deriveMinimumBet(100000), 10000);
});

test("buildHandAuditHash is deterministic", () => {
  const payload = {
    handId: "h1",
    table: "t1",
    gameType: "poker",
    actions: [{ type: "check" }],
    community: [],
    pot: 100,
    rake: 5,
    winners: [],
    seats: [],
    provablyFair: null,
  };
  const a = buildHandAuditHash(payload);
  const b = buildHandAuditHash(payload);
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("replayService builds steps from actions", () => {
  const replay = replayService.buildReplayDataFromEngine({
    handId: "h2",
    actions: [
      { type: "blind", ts: 1, seatIndex: 0, amount: 50 },
      { type: "check", ts: 2, round: "flop", playerId: "u1", seatIndex: 0 },
    ],
    community: ["Ah", "Kd", "Qc"],
    seats: [{ userId: "u1", name: "P1", chipsBefore: 1000, chipsAfter: 1000, hole: ["As", "Ad"] }],
    dealerSeatIndex: 0,
    smallBlind: 50,
    bigBlind: 100,
    pot: 100,
    rake: 0,
    winners: [],
    handCategory: null,
    startedAt: new Date(),
    endedAt: new Date(),
  });
  assert.ok(replay.steps.length >= 2);
  assert.equal(replay.version, 1);
});

test("spectator delay buffers state", () => {
  spectatorDelay.clearTable("t-delay");
  spectatorDelay.enqueueSpectatorState("t-delay", { pot: 100, round: "flop" });
  const immediate = spectatorDelay.getLatestDelayedState("t-delay");
  assert.equal(immediate, null);
});

test("spectator delay default is 30 seconds", () => {
  assert.ok(spectatorDelay.DEFAULT_DELAY_MS >= 30000);
});
